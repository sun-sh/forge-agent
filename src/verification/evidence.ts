import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

export const workspaceStampSchema = z.object({
  version: z.literal(1), scope: z.enum(['git', 'directory']), digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  files: z.number().int().min(0), reason: z.string().optional()
});
export type WorkspaceStamp = z.infer<typeof workspaceStampSchema>;
export const verificationEvidenceSchema = z.object({
  workspace: workspaceStampSchema, configHash: z.string().regex(/^[a-f0-9]{64}$/),
  freshness: z.enum(['current', 'stale', 'unconfirmed']), reason: z.string().optional(), invalidatedAt: z.iso.datetime().optional()
});
export type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>;
export function verificationConfigHash(commands: ReadonlyArray<{ name: string; command: string; timeoutMs?: number }>): string {
  return createHash('sha256').update(JSON.stringify(commands.map(({ name, command, timeoutMs }) => [name, command, timeoutMs ?? 300_000]))).digest('hex');
}
const MAX_FILES = 20_000, MAX_BYTES = 256 * 1024 * 1024, MAX_DURATION_MS = 20_000;
const excluded = /(^|\/)(?:\.git|node_modules|\.pforge|\.forge-agent|\.env[^/]*|\.npmrc|\.netrc|auth\.json|credentials?\.json|secrets?\.json|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))($|\/)/i;
function within(root: string, path: string) { const rest = relative(root, path); return rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest); }
function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((accept, reject) => execFile('git', ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 8_000_000, signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' }
  }, (error, stdout) => error ? reject(error) : accept(stdout)));
}

/** Content observation, not an OS snapshot. Never executes repository hooks or follows links.
 * Git scope covers tracked and non-ignored untracked files, HEAD and the index;
 * directory scope covers regular files. Credentials, dependencies and Forge state are excluded.
 * A partial/unreadable observation deliberately has no digest and cannot attest freshness.
 */
export async function captureWorkspace(root: string, signal?: AbortSignal): Promise<WorkspaceStamp> {
  let scope: WorkspaceStamp['scope'] = 'directory', files = 0;
  const started = Date.now();
  const check = () => { signal?.throwIfAborted(); if (Date.now() - started > MAX_DURATION_MS) throw new Error('Workspace observation exceeded its time limit.'); };
  try {
    const canonical = await realpath(root);
    let repository: string | undefined;
    try { repository = await realpath((await git(canonical, ['rev-parse', '--show-toplevel'], signal)).trim()); }
    catch { signal?.throwIfAborted(); }
    let index = '', head = '';
    const list = async (): Promise<string[]> => {
      check();
      if (repository) {
        scope = 'git';
        // An ancestor repository is allowed: Git paths are relative to this project.
        const [raw, staged, revision] = await Promise.all([
          git(canonical, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], signal),
          git(canonical, ['ls-files', '--stage', '-z', '--', '.'], signal),
          git(canonical, ['rev-parse', '--verify', 'HEAD'], signal).catch(() => { signal?.throwIfAborted(); return ''; })
        ]);
        index = staged; head = revision.trim();
        const names = [...new Set(raw.split('\0').filter(Boolean))];
        if (names.length > MAX_FILES) throw new Error('Workspace observation exceeded its file limit.');
        return names.filter((name) => !excluded.test(name)).sort();
      }
      const names: string[] = []; let visited = 0;
      const walk = async (dir: string, prefix = ''): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          check(); if (++visited > MAX_FILES) throw new Error('Workspace observation exceeded its file limit.');
          const path = prefix + entry.name;
          if (entry.name.toLowerCase() === '.git') throw new Error('Workspace observation cannot confirm nested repositories.');
          if (excluded.test(path)) continue;
          if (entry.isDirectory()) await walk(join(dir, entry.name), path + '/'); else names.push(path);
        }
      };
      await walk(canonical); return names.sort();
    };
    const paths = await list();
    const hash = createHash('sha256').update(JSON.stringify([scope, head, index, paths]));
    const metadata = [index, head]; let bytes = 0;
    const fingerprints = new Array<string>(paths.length); let cursor = 0;
    const read = async (path: string): Promise<string> => {
      check();
      const target = resolve(canonical, path);
      if (!within(canonical, target)) throw new Error('Workspace observation encountered an unsafe path.');
      let info;
      try { info = await lstat(target); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        files++; return 'deleted';
      }
      if (!info.isFile() || info.isSymbolicLink() || !within(canonical, await realpath(target))) throw new Error('Workspace observation cannot confirm links or nested repositories.');
      if ((bytes += info.size) > MAX_BYTES) throw new Error('Workspace observation exceeded its byte limit.');
      const handle = await open(target, 'r');
      try {
        const before = await handle.stat(), content = createHash('sha256');
        const buffer = Buffer.allocUnsafe(64 * 1024); let size = 0;
        for (;;) {
          check(); const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          size += bytesRead; if (size > info.size) throw new Error('Workspace changed during observation.');
          content.update(buffer.subarray(0, bytesRead));
        }
        const after = await handle.stat();
        if (before.size !== size || before.ino !== info.ino || before.size !== info.size || before.mtimeMs !== info.mtimeMs || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Workspace changed during observation.');
        files++; return JSON.stringify([info.mode, content.digest('hex')]);
      } finally { await handle.close(); }
    };
    // Bounded concurrent I/O keeps repository observation practical on Windows.
    // Hash the collected results in path order, independent of completion order.
    const readers = await Promise.allSettled(Array.from({ length: Math.min(8, paths.length) }, async () => {
      for (;;) { const index = cursor++; if (index >= paths.length) return; fingerprints[index] = await read(paths[index]!); }
    }));
    const failure = readers.find((result) => result.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
    for (let index = 0; index < paths.length; index++) hash.update(JSON.stringify([paths[index], fingerprints[index]]));
    if (JSON.stringify(paths) !== JSON.stringify(await list()) || metadata[0] !== index || metadata[1] !== head) throw new Error('Workspace changed during observation.');
    return { version: 1, scope, digest: hash.digest('hex'), files };
  } catch (error) {
    signal?.throwIfAborted();
    return { version: 1, scope, files, reason: error instanceof Error && /^(Workspace|Current)/.test(error.message) ? error.message : 'Workspace contents could not be fully observed.' };
  }
}

export function invalidateEvidence(evidence: VerificationEvidence, reason: string): VerificationEvidence {
  if (evidence.freshness === 'stale') return evidence;
  return { ...evidence, freshness: 'stale', reason, invalidatedAt: new Date().toISOString() };
}
/** Staleness is sticky: reverting a file does not silently restore an old attestation. */
export function revalidateEvidence(evidence: VerificationEvidence, workspace: WorkspaceStamp, configHash: string): VerificationEvidence {
  if (evidence.freshness !== 'current') return evidence;
  if (evidence.configHash !== configHash) return invalidateEvidence(evidence, '验证命令配置已改变，请重新验证。');
  if (!workspace.digest) return { ...evidence, freshness: 'unconfirmed', reason: workspace.reason ?? '当前工作区版本无法确认。' };
  if (evidence.workspace.scope !== workspace.scope || evidence.workspace.digest !== workspace.digest) return invalidateEvidence(evidence, '验证后工作区已改变，请重新验证。');
  return evidence;
}
