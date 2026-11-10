import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { directoryKey } from '../project-identity.js';
import { replaceMetadataFile } from './persistence.js';

const MAX_FILES = 1500, MAX_FILE_BYTES = 2_000_000, MAX_TOTAL_BYTES = 32_000_000;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const uuid = z.uuid();
const fileSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), mode: z.number().int() }).strict();
const snapshotSchema = z.object({ head: z.string(), index: z.string(), files: z.record(z.string(), fileSchema), skipped: z.array(z.string()) }).strict();
const manifestSchema = z.object({
  version: z.literal(1), id: uuid, sessionId: uuid, project: z.string(), label: z.string().max(300),
  kind: z.enum(['task', 'proposal']), status: z.enum(['open', 'sealed', 'applying']), createdAt: z.string(), sealedAt: z.string().optional(),
  before: snapshotSchema, after: snapshotSchema.optional(), applied: z.array(z.string()), diagnostic: z.string().optional()
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;
type FileVersion = z.infer<typeof fileSchema>;
export class CheckpointError extends Error { constructor(public readonly status: number, message: string) { super(message); } }
export function safeCheckpointPath(path: string) {
  return !!path && path.length < 4096 && !isAbsolute(path) && !/[\\\0:\r\n]/.test(path)
    && !path.split('/').some((part) => !part || part === '.' || part === '..')
    && (process.platform !== 'win32' || !path.split('/').some((part) => /[. ]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    && !/(^|\/)(?:\.git|\.pi|\.pforge|\.forge-agent|\.env[^/]*|\.npmrc|\.netrc|auth\.json|credentials?[^/]*|secrets?[^/]*|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))($|\/)/i.test(path);
}
function within(root: string, target: string) { const rest = relative(root, target); return rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest); }
export function checkpointGit(root: string, args: string[]): Promise<string> {
  return new Promise((accept, reject) => execFile('git', ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8_000_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' }
  }, (error, stdout) => error ? reject(error) : accept(stdout)));
}
/** Refuse links in every component, including a deleted file's surviving parents. */
export async function checkpointTarget(root: string, path: string) {
  root = await realpath(root);
  if (!safeCheckpointPath(path)) throw new CheckpointError(400, '文件路径不允许用于检查点');
  const target = resolve(root, path);
  if (!within(root, target)) throw new CheckpointError(400, '文件超出项目目录');
  let cursor = root;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !within(root, await realpath(cursor))) throw new CheckpointError(409, '文件路径包含链接，已拒绝写入：' + path);
      const canonical = relative(root, await realpath(cursor)).split(sep).join('/');
      if (!safeCheckpointPath(canonical) || (info.isFile() && info.nlink > 1)) throw new CheckpointError(409, '文件路径不是独立的普通项目文件：' + path);
      if (cursor !== target && !info.isDirectory()) throw new CheckpointError(409, '文件的父目录已改变：' + path);
      if (cursor === target && !info.isFile()) throw new CheckpointError(409, '目标不是普通文件：' + path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}
async function fileVersion(root: string, path: string): Promise<{ version: FileVersion; bytes?: Buffer }> {
  const target = await checkpointTarget(root, path);
  try {
    const info = await lstat(target);
    if (info.size > MAX_FILE_BYTES) throw new CheckpointError(409, '文件超过检查点大小限制：' + path);
    const handle = await open(target, 'r');
    try {
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_FILE_BYTES) throw new CheckpointError(409, '文件超过检查点大小限制：' + path);
      const content = bytes.subarray(0, bytesRead);
      return { version: { hash: hash(content), mode: info.mode & 0o777 }, bytes: content };
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: { hash: null, mode: 0o644 } };
    throw error;
  }
}
const equal = (a: FileVersion, b: FileVersion) => a.hash === b.hash && (process.platform === 'win32' || a.hash === null || a.mode === b.mode);
const absent: FileVersion = { hash: null, mode: 0o644 };
const versionAt = (snapshot: Snapshot, path: string) => Object.hasOwn(snapshot.files, path) ? snapshot.files[path]! : absent;

/** Bounded working-tree snapshots. Never modifies HEAD, Git's index, or ignored files. */
export class CheckpointStore {
  private readonly root: string;
  constructor(home: string) { this.root = join(home, 'checkpoints'); }
  private directory(id: string) { if (!uuid.safeParse(id).success) throw new CheckpointError(400, '无效的检查点 ID'); return join(this.root, id); }
  private async save(record: Manifest) {
    const directory = this.directory(record.id); await mkdir(directory, { recursive: true });
    const temporary = join(directory, randomUUID() + '.tmp');
    try { await writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600 }); await replaceMetadataFile(temporary, join(directory, 'manifest.json')); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  private async load(id: string, project: string, sessionId: string) {
    let record: Manifest;
    try { record = manifestSchema.parse(JSON.parse(await readFile(join(this.directory(id), 'manifest.json'), 'utf8'))); }
    catch (error) { if (error instanceof CheckpointError) throw error; throw new CheckpointError(404, '检查点不存在或记录不可读'); }
    if (record.id !== id || record.sessionId !== sessionId || directoryKey(record.project) !== directoryKey(await realpath(project))) throw new CheckpointError(403, '检查点不属于当前项目和会话');
    for (const path of [...Object.keys(record.before.files), ...Object.keys(record.after?.files ?? {}), ...record.applied]) if (!safeCheckpointPath(path)) throw new CheckpointError(409, '检查点包含不安全的路径');
    return record;
  }
  private async snapshot(project: string, id: string): Promise<Snapshot> {
    const canonical = await realpath(project), repository = await realpath((await checkpointGit(project, ['rev-parse', '--show-toplevel'])).trim());
    if (directoryKey(canonical) !== directoryKey(repository)) throw new CheckpointError(409, '检查点需要打开 Git 仓库根目录');
    const [head, indexRaw, pathRaw] = await Promise.all([
      checkpointGit(project, ['rev-parse', '--verify', 'HEAD']).then((value) => value.trim(), () => ''),
      checkpointGit(project, ['ls-files', '--stage', '-z']),
      checkpointGit(project, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    ]);
    const index = hash(indexRaw);
    const paths = [...new Set(pathRaw.split('\0').filter(Boolean))];
    const files: Snapshot['files'] = Object.create(null), skipped: string[] = []; let total = 0;
    const objects = join(this.directory(id), 'objects'); await mkdir(objects, { recursive: true });
    for (const path of paths) {
      if (!safeCheckpointPath(path)) { skipped.push(path); continue; }
      if (Object.keys(files).length >= MAX_FILES || total >= MAX_TOTAL_BYTES) { skipped.push(path); continue; }
      try {
        const { version, bytes } = await fileVersion(canonical, path);
        if (bytes && total + bytes.length > MAX_TOTAL_BYTES) { skipped.push(path); continue; }
        if (bytes && version.hash) { total += bytes.length; try { await writeFile(join(objects, version.hash), bytes, { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
        files[path] = version;
      } catch (error) { if (!(error instanceof CheckpointError)) throw error; skipped.push(path); }
    }
    return { head, index, files, skipped };
  }
  async begin(project: string, sessionId: string, label: string, kind: Manifest['kind'] = 'task') {
    uuid.parse(sessionId); const id = randomUUID(), canonical = await realpath(project);
    const before = await this.snapshot(canonical, id);
    await this.save({ version: 1, id, sessionId, project: canonical, label: label.slice(0, 300), kind, status: 'open', createdAt: new Date().toISOString(), before, applied: [] });
    return id;
  }
  async seal(id: string, project: string, sessionId: string, source = project) {
    const record = await this.load(id, project, sessionId);
    if (record.status !== 'open') throw new CheckpointError(409, '检查点已封存');
    if (source !== project && record.kind !== 'proposal') throw new CheckpointError(400, '普通检查点不能使用其他工作目录');
    record.after = await this.snapshot(source, id); record.status = 'sealed'; record.sealedAt = new Date().toISOString(); await this.save(record);
    return this.view(id, project, sessionId);
  }
  private changes(record: Manifest) {
    if (!record.after) return [];
    const skipped = new Set([...record.before.skipped, ...record.after.skipped]);
    return [...new Set([...Object.keys(record.before.files), ...Object.keys(record.after.files)])].filter((path) => !skipped.has(path)).flatMap((path) => {
      const before = versionAt(record.before, path), after = versionAt(record.after!, path);
      return equal(before, after) ? [] : [{ path, before, after }];
    });
  }
  async view(id: string, project: string, sessionId: string) {
    const record = await this.load(id, project, sessionId), proposal = record.kind === 'proposal';
    let reason: string | undefined;
    if (record.status !== 'sealed') reason = record.status === 'applying' ? '上次文件恢复被中断，请人工检查；不会自动重放。' : '执行尚未封存，暂不能恢复文件。';
    let currentHead = '', currentIndex = '';
    try {
      try { currentHead = (await checkpointGit(project, ['rev-parse', '--verify', 'HEAD'])).trim(); } catch { /* unborn */ }
      currentIndex = hash(await checkpointGit(project, ['ls-files', '--stage', '-z']));
      if (record.before.head !== currentHead || record.after?.head !== record.before.head) reason ??= '仓库 HEAD 已改变，请人工检查文件变更。';
      if (!proposal && (record.after?.index !== record.before.index || currentIndex !== record.after?.index)) reason ??= '暂存区已改变，为保留暂存内容，不能自动撤销。';
    } catch { reason ??= '无法读取当前仓库状态。'; }
    const files = await Promise.all(this.changes(record).map(async (file) => {
      let conflict = false;
      try { conflict = !equal((await fileVersion(project, file.path)).version, proposal ? file.before : file.after); } catch { conflict = true; }
      const applied = record.applied.includes(file.path);
      return { path: file.path, operation: file.before.hash === null ? 'add' : file.after.hash === null ? 'delete' : 'modify', applied, conflict: !applied && conflict, eligible: !reason && !applied && !conflict };
    }));
    return { id, kind: record.kind, label: record.label, status: record.status, createdAt: record.createdAt, sealedAt: record.sealedAt,
      revision: hash(JSON.stringify(record)), reason, diagnostic: record.diagnostic, skipped: [...new Set([...record.before.skipped, ...(record.after?.skipped ?? [])])].length, files };
  }
  private async bytes(id: string, version: FileVersion) {
    if (version.hash === null) return undefined;
    const bytes = await readFile(join(this.directory(id), 'objects', version.hash));
    if (bytes.length > MAX_FILE_BYTES || hash(bytes) !== version.hash) throw new CheckpointError(409, '检查点内容校验失败');
    return bytes;
  }
  async diff(id: string, project: string, sessionId: string, path: string) {
    const record = await this.load(id, project, sessionId), file = this.changes(record).find((entry) => entry.path === path);
    if (!file) throw new CheckpointError(404, '文件不在此检查点的变更中');
    const before = await this.bytes(id, file.before), after = await this.bytes(id, file.after);
    const binary = before?.includes(0) || after?.includes(0);
    const diff = binary ? '(二进制内容，无法预览)' : `--- 执行前/${path}\n+++ 执行后/${path}\n` + (before?.toString('utf8') ?? '').split('\n').map((line) => '-' + line).join('\n') + '\n' + (after?.toString('utf8') ?? '').split('\n').map((line) => '+' + line).join('\n');
    return { path, diff: diff.slice(0, 200_000), truncated: diff.length > 200_000 };
  }
  private async replace(root: string, path: string, bytes: Buffer | undefined, mode: number) {
    const target = await checkpointTarget(root, path);
    if (!bytes) { try { await unlink(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } return; }
    await mkdir(dirname(target), { recursive: true });
    await checkpointTarget(root, path);
    const temporary = target + '.forge-' + randomUUID() + '.tmp';
    try { await writeFile(temporary, bytes, { flag: 'wx', mode }); await checkpointTarget(root, path); await rename(temporary, target); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  /** Caller holds the project's execution lease and has checked Pi trust. */
  async apply(id: string, project: string, sessionId: string, paths: string[], revision: string) {
    const record = await this.load(id, project, sessionId), view = await this.view(id, project, sessionId);
    if (revision !== view.revision) throw new CheckpointError(409, '检查点已更新，请刷新后重试');
    if (!paths.length || paths.length > MAX_FILES || new Set(paths).size !== paths.length) throw new CheckpointError(400, '请选择要恢复的文件');
    if (paths.some((path) => !view.files.find((file) => file.path === path)?.eligible)) throw new CheckpointError(409, view.reason ?? '文件已有后续修改或不属于此检查点，请刷新后检查冲突');
    const selected = this.changes(record).filter((file) => paths.includes(file.path));
    const proposal = record.kind === 'proposal';
    const writes = await Promise.all(selected.map(async (file) => ({ ...file, desired: proposal ? file.after : file.before, expected: proposal ? file.before : file.after,
      bytes: await this.bytes(id, proposal ? file.after : file.before) })));
    // A durable journal precedes writes. If the process dies, the next owner
    // presents an interrupted operation instead of replaying filesystem writes.
    record.status = 'applying'; await this.save(record);
    try {
      for (const file of writes) {
        if (!equal((await fileVersion(project, file.path)).version, file.expected)) throw new CheckpointError(409, '写入前检测到文件冲突：' + file.path);
        await this.replace(project, file.path, file.bytes, file.desired.mode);
        record.applied.push(file.path); await this.save(record);
      }
      record.status = 'sealed'; record.diagnostic = undefined; await this.save(record);
    } catch (error) {
      record.status = 'sealed'; record.diagnostic = '部分操作可能已完成；请检查已处理文件。' + (error instanceof Error ? error.message : String(error));
      await this.save(record); throw error;
    }
    return this.view(id, project, sessionId);
  }
  /** Seed only eligible working files into a newly-created, owned worktree. */
  async seed(id: string, project: string, sessionId: string, worktree: string) {
    const record = await this.load(id, project, sessionId);
    if (record.kind !== 'proposal' || record.status !== 'open') throw new CheckpointError(409, '此检查点不能初始化子任务');
    for (const [path, version] of Object.entries(record.before.files)) await this.replace(worktree, path, await this.bytes(id, version), version.mode);
  }
}
