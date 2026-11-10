import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_FILES = 200, MAX_BYTES = 200000, MAX_FILE_BYTES = 2000000;
export interface GitFile { path: string; status: string; fingerprint: string; }
export interface GitBaseline { available: boolean; reason?: string; head?: string; files: GitFile[]; truncated?: boolean; }
export interface GitChanges {
  available: boolean; reason?: string; head?: string; headChanged?: boolean; truncated: boolean;
  files: Array<GitFile & { preexisting: boolean; observed: boolean }>;
}
function within(root: string, path: string) { const rest = relative(root, path); return rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest); }
function sensitive(path: string) { return /(^|\/)(?:\.git|\.pforge|\.forge-agent|\.env[^/]*|\.npmrc|\.netrc|auth\.json|credentials?\.json|secrets?\.json|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))($|\/)/i.test(path); }
function validPath(path: string) { return path.length > 0 && path.length < 4096 && !isAbsolute(path) && !path.split(/[\\/]/).some((part) => part === '..' || part === '.git') && !path.includes('\0'); }
function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((accept, reject) => execFile('git', ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4000000, signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' }
  }, (error, stdout) => error ? reject(error) : accept(stdout)));
}
async function safeRead(root: string, path: string): Promise<Buffer | undefined> {
  if (!validPath(path) || sensitive(path)) return undefined;
  const target = resolve(root, path);
  if (!within(root, target)) return undefined;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES || !within(root, await realpath(target))) return undefined;
    const file = await open(target, 'r');
    try {
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1), result = await file.read(buffer, 0, buffer.length, 0);
      if (result.bytesRead > MAX_FILE_BYTES) return undefined;
      return buffer.subarray(0, result.bytesRead);
    } finally { await file.close(); }
  } catch { return undefined; }
}
export async function captureGit(root: string, signal?: AbortSignal): Promise<GitBaseline> {
  try {
    const canonical = await realpath(root), repository = await realpath((await git(root, ['rev-parse', '--show-toplevel'], signal)).trim());
    if (relative(canonical, repository) !== '') return { available: false, reason: '当前文件夹不是 Git 仓库根目录，请打开仓库根目录查看变更。', files: [] };
    // Independent metadata reads share one scheduling window. On Windows,
    // serial process startup used to consume most of a short task's idle wait.
    const [raw, indexRaw, head] = await Promise.all([
      git(root, ['-c', 'status.renames=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], signal),
      git(root, ['ls-files', '-s', '-z'], signal),
      git(root, ['rev-parse', '--verify', 'HEAD'], signal).then((value) => value.trim(), () => undefined)
    ]);
    const index = new Map<string, string>();
    for (const line of indexRaw.split('\0')) { const separator = line.indexOf('\t'); if (separator >= 0) { const path = line.slice(separator + 1); index.set(path, (index.get(path) ?? '') + line.slice(0, separator)); } }
    const entries = raw.split('\0'), files: GitFile[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]; if (!entry) continue;
      const status = entry.slice(0, 2), path = entry.slice(3);
      if (/[RC]/.test(status)) i++; // -z includes the old name as a second field.
      if (!validPath(path)) continue;
      if (files.length === MAX_FILES) return { available: true, files, truncated: true };
      const bytes = await safeRead(canonical, path);
      let metadata = 'unavailable-or-deleted';
      if (!bytes) { try { const info = await lstat(resolve(canonical, path)); metadata = `${info.size}:${info.mtimeMs}`; } catch { /* Deleted file. */ } }
      files.push({ path, status, fingerprint: createHash('sha256').update(index.get(path) ?? '').update(bytes ?? metadata).digest('hex') });
    }
    return { available: true, head, files };
  } catch (error) {
    signal?.throwIfAborted();
    return { available: false, reason: '无法读取 Git 仓库状态（文件夹可能尚未初始化 Git）。', files: [] };
  }
}
export async function compareGit(root: string, baseline: GitBaseline, signal?: AbortSignal): Promise<GitChanges> {
  const current = await captureGit(root, signal), before = new Map(baseline.files.map((file) => [file.path, file]));
  return { available: current.available, reason: current.reason, head: current.head, headChanged: baseline.available && baseline.head !== current.head, truncated: Boolean(current.truncated || baseline.truncated),
    files: current.files.map((file) => ({ ...file, preexisting: before.has(file.path), observed: baseline.available && before.get(file.path)?.fingerprint !== file.fingerprint })) };
}
export async function readGitDiff(root: string, path: string, signal?: AbortSignal): Promise<{ path: string; diff: string; truncated: boolean }> {
  if (!validPath(path)) throw new Error('Invalid repository path');
  const current = await captureGit(root, signal), file = current.files.find((item) => item.path === path);
  if (!current.available || !file) throw new Error('File is not in the current Git changes');
  if (sensitive(path)) return { path, diff: '凭据或敏感文件不在 Web 变更面板中预览。', truncated: false };
  const canonical = await realpath(root), target = resolve(canonical, path);
  try { if (!within(canonical, await realpath(target)) || (await lstat(target)).isSymbolicLink()) throw new Error('Symlink previews are unavailable'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let diff: string;
  if (file.status === '??') {
    const bytes = await safeRead(canonical, path);
    diff = !bytes ? '(大文件、目录或链接无法预览)' : bytes.includes(0) ? '(二进制文件)' : '--- /dev/null\n+++ ' + path + '\n' + bytes.toString('utf8').split('\n').map((line) => '+' + line).join('\n');
  } else {
    const [staged, unstaged] = await Promise.all([
      git(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', '--', path], signal),
      git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--', path], signal)
    ]);
    diff = (staged ? '[暂存区]\n' + staged : '') + (unstaged ? '\n[工作区]\n' + unstaged : '');
  }
  return { path, diff: diff.slice(0, MAX_BYTES) || '(内容无文本差异)', truncated: diff.length > MAX_BYTES };
}

export class ReviewEvidenceError extends Error {}
export interface ReviewPatch {
  version: 1;
  files: Array<{ path: string; status: string; preexisting: boolean; observed: boolean; patch: string }>;
  characters: number;
  lines: number;
}
const REVIEW_FILE_LINES = 2_000, REVIEW_TOTAL_CHARACTERS = 60_000;
function changeVersion(changes: Pick<GitBaseline, 'head' | 'files'>) { return JSON.stringify({ head: changes.head, files: changes.files.map(({ path, status, fingerprint }) => ({ path, status, fingerprint })) }); }

/** Delivery review gets complete, bounded hunks, never the UI's truncated preview. */
export async function captureReviewPatch(root: string, changes: GitChanges, signal?: AbortSignal): Promise<ReviewPatch> {
  if (!changes.available || changes.truncated || changes.headChanged) throw new ReviewEvidenceError('审阅证据不完整：需要完整 Git 变更清单及未改变的 HEAD，请人工检查。');
  const canonical = await realpath(root), files: ReviewPatch['files'] = [];
  let characters = 0, lines = 0;
  for (const file of changes.files) {
    signal?.throwIfAborted();
    if (!validPath(file.path) || sensitive(file.path)) throw new ReviewEvidenceError('审阅包含无法安全读取的路径，请人工检查；未将敏感内容交给审阅模型。');
    const target = resolve(canonical, file.path);
    try { if ((await lstat(target)).isSymbolicLink() || !within(canonical, await realpath(target))) throw new ReviewEvidenceError('审阅不支持链接路径，请人工检查。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let patch: string;
    if (file.status === '??') {
      const bytes = await safeRead(canonical, file.path);
      if (!bytes || bytes.includes(0)) throw new ReviewEvidenceError('审阅证据包含二进制、过大或不可读取的新文件，请人工检查。');
      patch = '--- /dev/null\n+++ ' + file.path + '\n' + bytes.toString('utf8').split('\n').map((line) => '+' + line).join('\n');
    } else {
      try {
        const [staged, unstaged] = await Promise.all([
          git(canonical, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', '--', file.path], signal),
          git(canonical, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--', file.path], signal)
        ]);
        patch = (staged ? '[index]\n' + staged : '') + (unstaged ? '[worktree]\n' + unstaged : '');
      } catch {
        signal?.throwIfAborted(); throw new ReviewEvidenceError('无法完整读取审阅补丁，未截断为有效证据。');
      }
      if (/^(?:Binary files |GIT binary patch)/m.test(patch)) throw new ReviewEvidenceError('审阅证据包含二进制变更，请人工检查。');
      if (!patch) throw new ReviewEvidenceError('Git 变更无法提供完整文本补丁，请人工检查。');
    }
    const count = patch.split('\n').length;
    if (count > REVIEW_FILE_LINES || characters + patch.length > REVIEW_TOTAL_CHARACTERS) throw new ReviewEvidenceError('审阅证据过大：每文件最多 2,000 行，补丁总量最多 60,000 字符；未截断为有效审阅。');
    files.push({ path: file.path, status: file.status, preexisting: file.preexisting, observed: file.observed, patch });
    characters += patch.length; lines += count;
  }
  const current = await captureGit(canonical, signal);
  if (!current.available || current.truncated || changeVersion(current) !== changeVersion(changes)) throw new ReviewEvidenceError('生成审阅补丁期间工作区发生变化，请重新验证。');
  return { version: 1, files, characters, lines };
}
