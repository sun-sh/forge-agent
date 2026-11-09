import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const MAX_ENTRIES = 20_000, MAX_BYTES = 256 * 1024 * 1024, MAX_DURATION_MS = 20_000;
export function normalizeProtectedPath(path: string) { return path.replaceAll('\\', '/').replace(/^\.\//, ''); }
/** Literal portable paths only; reject drive-relative names, ADS and Windows aliases too. */
export function safeProtectedPath(path: string) {
  const normalized = normalizeProtectedPath(path);
  return normalized.length > 0 && normalized.length <= 4096 && !isAbsolute(normalized) && !/[\x00-\x1f:*?"<>|]/.test(normalized)
    && !normalized.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || part.toLowerCase() === '.git');
}
const entrySchema = z.object({ path: z.string().min(1).max(4096), kind: z.enum(['missing', 'file', 'directory']), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const protectedSnapshotSchema = z.object({
  version: z.literal(1), paths: z.array(entrySchema).max(200), digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  complete: z.boolean(), reason: z.string().max(1000).optional()
}).strict();
export type ProtectedSnapshot = z.infer<typeof protectedSnapshotSchema>;
export const protectedCheckSchema = z.object({
  status: z.enum(['unchanged', 'changed', 'unconfirmed']), baseline: protectedSnapshotSchema,
  currentDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  changes: z.array(z.object({ path: z.string().max(4096), kind: z.enum(['added', 'removed', 'modified']) }).strict()).max(200),
  reason: z.string().max(1000).optional()
}).strict();
export type ProtectedCheck = z.infer<typeof protectedCheckSchema>;
function within(root: string, path: string) { const rest = relative(root, path); return rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest); }
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Bounded content observation; never follows links or exposes protected content. */
export async function captureProtectedPaths(root: string, paths: ReadonlyArray<string>, signal?: AbortSignal): Promise<ProtectedSnapshot> {
  const started = Date.now(), names = [...new Set(paths.map(normalizeProtectedPath))].sort();
  let entries = 0, bytes = 0;
  const check = () => { signal?.throwIfAborted(); if (Date.now() - started > MAX_DURATION_MS) throw new Error('Protected path observation exceeded its time limit.'); };
  try {
    if (names.length > 200 || names.some((path) => !safeProtectedPath(path))) throw new Error('Protected configuration contains an unsafe path.');
    const canonical = await realpath(root);
    const observe = async (target: string): Promise<{ kind: 'file' | 'directory'; fingerprint: string }> => {
      check(); if (++entries > MAX_ENTRIES) throw new Error('Protected path observation exceeded its entry limit.');
      const info = await lstat(target);
      if (info.isSymbolicLink() || !within(canonical, await realpath(target))) throw new Error('Protected paths cannot contain links.');
      if (info.isDirectory()) {
        const children = (await readdir(target)).sort(), hash = createHash('sha256');
        for (const child of children) {
          if (child.toLowerCase() === '.git') throw new Error('Protected paths cannot include Git metadata.');
          hash.update(JSON.stringify([child, await observe(join(target, child))]));
        }
        if (JSON.stringify(children) !== JSON.stringify((await readdir(target)).sort())) throw new Error('Protected directory changed during observation.');
        return { kind: 'directory', fingerprint: hash.digest('hex') };
      }
      if (!info.isFile()) throw new Error('Protected paths must contain regular files.');
      if ((bytes += info.size) > MAX_BYTES) throw new Error('Protected path observation exceeded its byte limit.');
      const handle = await open(target, 'r');
      try {
        const before = await handle.stat(), hash = createHash('sha256').update(String(info.mode)), buffer = Buffer.allocUnsafe(64 * 1024); let size = 0;
        for (;;) {
          check(); const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
          size += bytesRead; if (size > info.size) throw new Error('Protected file changed during observation.');
          hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await handle.stat(), current = await lstat(target);
        if (size !== info.size || before.ino !== info.ino || before.mtimeMs !== info.mtimeMs || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.ino !== info.ino || current.mtimeMs !== info.mtimeMs || current.isSymbolicLink()) throw new Error('Protected file changed during observation.');
        return { kind: 'file', fingerprint: hash.digest('hex') };
      } finally { await handle.close(); }
    };
    const observed: ProtectedSnapshot['paths'] = [];
    for (const path of names) {
      check(); let target = canonical, missing = false;
      // Validate every ancestor so an in-project link cannot redirect traversal.
      for (const part of path.split('/')) {
        target = join(target, part);
        try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Protected paths cannot contain links.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { missing = true; break; } throw error; }
      }
      if (!within(canonical, resolve(canonical, path))) throw new Error('Protected configuration escaped the project root.');
      observed.push(missing ? { path, kind: 'missing', fingerprint: sha('missing') } : { path, ...await observe(target) });
    }
    return { version: 1, paths: observed, complete: true, digest: sha(JSON.stringify(observed)) };
  } catch (error) {
    signal?.throwIfAborted();
    return { version: 1, paths: [], complete: false, reason: error instanceof Error && /^(Protected)/.test(error.message) ? error.message : 'Protected paths could not be fully observed.' };
  }
}

export function compareProtectedPaths(baseline: ProtectedSnapshot, current: ProtectedSnapshot): ProtectedCheck {
  const changes: ProtectedCheck['changes'] = [], old = new Map(baseline.paths.map((entry) => [entry.path, entry]));
  for (const entry of current.paths) {
    const before = old.get(entry.path);
    if (!before || before.fingerprint !== entry.fingerprint || before.kind !== entry.kind) changes.push({ path: entry.path, kind: before?.kind === 'missing' ? 'added' : entry.kind === 'missing' ? 'removed' : 'modified' });
    old.delete(entry.path);
  }
  for (const entry of old.values()) changes.push({ path: entry.path, kind: 'removed' });
  const unconfirmed = !baseline.complete || !current.complete || !baseline.digest || !current.digest;
  return { baseline, currentDigest: current.digest, changes: unconfirmed ? [] : changes, status: unconfirmed ? 'unconfirmed' : changes.length ? 'changed' : 'unchanged',
    ...(unconfirmed ? { reason: current.reason ?? baseline.reason ?? 'Protected paths could not be fully observed.' } : {}) };
}
export function protectedCheckMessage(check?: ProtectedCheck): string {
  if (!check || check.status === 'unchanged') return '';
  if (check.status === 'unconfirmed') return 'Protected-path integrity is unconfirmed; completion is blocked. ' + (check.reason ?? 'Fix the configuration and explicitly retry.');
  return 'Protected paths changed since this execution started; completion is blocked. Restore these paths to their initial contents before retrying verification. Preserve any pre-existing user edits.\n' + check.changes.map(({ kind, path }) => `${kind}: ${path}`).join('\n');
}
