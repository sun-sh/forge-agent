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
    const raw = await git(root, ['-c', 'status.renames=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], signal);
    const indexRaw = await git(root, ['ls-files', '-s', '-z'], signal);
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
    let head: string | undefined;
    try { head = (await git(root, ['rev-parse', '--verify', 'HEAD'], signal)).trim(); } catch { /* Unborn repositories are supported. */ }
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
