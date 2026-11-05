import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';

export class HistoryError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'HistoryError'; }
}
const historySchema = z.object({
  version: z.literal(1), pinned: z.boolean(), status: z.enum(['active', 'archived', 'trashed'])
}).strict();
const forkSchema = z.object({
  version: z.literal(1), sourcePath: z.string().min(1), sourceTitle: z.string().max(120),
  entryId: z.string().min(1), kind: z.enum(['edit', 'continue'])
}).strict();
export type HistoryState = z.infer<typeof historySchema>;
export function historyState(manager: SessionManager): HistoryState {
  const entry = [...manager.getEntries()].reverse().find((item) => item.type === 'custom' && item.customType === 'forge.web.history');
  return historySchema.safeParse(entry?.type === 'custom' ? entry.data : undefined).data
    ?? { version: 1, pinned: false, status: 'active' };
}
export function forkOrigin(manager: SessionManager) {
  const entry = [...manager.getBranch()].reverse().find((item) => item.type === 'custom' && item.customType === 'forge.web.fork');
  return forkSchema.safeParse(entry?.type === 'custom' ? entry.data : undefined).data;
}
function messageText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part: any) => part?.type === 'text').map((part: any) => String(part.text ?? '')).join('\n');
}
function messageThinking(content: unknown) {
  if (!Array.isArray(content)) return '';
  return content.filter((part: any) => part?.type === 'thinking').map((part: any) => String(part.thinking ?? '')).join('\n');
}
function fenced(value: string) {
  const fence = value.includes('```') ? '````' : '```';
  return fence + '\n' + value + (value.endsWith('\n') ? '' : '\n') + fence;
}
function exportFileName(title: string, extension: string) {
  const safe = title.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'forge-session';
  return safe + '.' + extension;
}
export type SessionExport = { filename: string; contentType: string; body: string };
export function exportSession(manager: SessionManager, format: 'markdown' | 'json'): SessionExport {
  const title = sessionTitle(manager);
  const entries = manager.getBranch();
  if (format === 'json') {
    return {
      filename: exportFileName(title, 'json'),
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ version: 1, title, project: manager.getCwd(), sessionId: manager.getSessionId(), history: historyState(manager), fork: forkOrigin(manager), entries }, null, 2) + '\n'
    };
  }
  const lines = [
    '# ' + title,
    '',
    '> Forge Agent 会话导出',
    '',
    '- 项目：`' + manager.getCwd().replaceAll('`', '') + '`',
    '- 会话 ID：`' + manager.getSessionId() + '`',
    '- 导出时间：' + new Date().toISOString(),
    ''
  ];
  for (const entry of entries as any[]) {
    if (entry.type === 'message') {
      const message = entry.message;
      if (message.role === 'user') {
        lines.push('## 用户', '', messageText(message.content), '');
      } else if (message.role === 'assistant') {
        const thinking = messageThinking(message.content);
        const text = messageText(message.content);
        lines.push('## Forge', '');
        if (thinking) lines.push('<details><summary>思考</summary>', '', fenced(thinking), '', '</details>', '');
        if (text) lines.push(text, '');
        if (message.errorMessage) lines.push('> 模型错误：' + String(message.errorMessage), '');
      } else if (message.role === 'toolResult') {
        lines.push('### 工具结果 · ' + String(message.toolName ?? 'tool'), '', fenced(messageText(message.content)), '');
      } else if (message.role === 'bashExecution') {
        lines.push('### 命令执行', '', fenced(String(message.command ?? '')), '', fenced(String(message.output ?? '')), '');
      }
    } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      lines.push('> 上下文摘要', '', String(entry.summary ?? ''), '');
    } else if (entry.type === 'custom_message' && entry.display !== false) {
      lines.push('### ' + String(entry.customType ?? '扩展消息'), '', messageText(entry.content), '');
    }
  }
  return { filename: exportFileName(title, 'md'), contentType: 'text/markdown; charset=utf-8', body: lines.join('\n') };
}
function within(path: string, root: string) {
  const rest = relative(root, path);
  return rest !== '' && rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest);
}
/** Validate before Pi opens the file: opening an empty/missing file would create a session. */
export async function historyPath(value: unknown, root: string): Promise<string> {
  if (typeof value !== 'string' || !value.trim()) throw new HistoryError(400, '会话路径不在 Forge 的历史目录内');
  const candidate = resolve(value);
  try {
    const canonicalRoot = await realpath(root);
    let path: string;
    try {
      path = await realpath(candidate);
    } catch {
      // Preserve a useful 400 for a non-existent path outside the session
      // root while accepting Windows 8.3 aliases for paths inside it.
      const parent = await realpath(resolve(candidate, '..')).catch(() => undefined);
      if (parent && parent !== canonicalRoot && !within(parent, canonicalRoot)) throw new HistoryError(400, '会话路径指向历史目录之外');
      throw new HistoryError(404, '会话文件不存在或无法读取');
    }
    if (!within(path, canonicalRoot)) throw new HistoryError(400, '会话路径指向历史目录之外');
    if (!(await stat(path)).isFile()) throw new HistoryError(404, '会话文件不存在');
    const file = await open(path, 'r');
    try {
      const bytes = Buffer.alloc(131072);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const line = bytes.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0]!;
      let header;
      try { header = JSON.parse(line); } catch { throw new HistoryError(400, '会话文件格式无效'); }
      if (header?.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string' || !header.cwd) throw new HistoryError(400, '会话文件格式无效');
    } finally { await file.close(); }
    return path;
  } catch (error) {
    if (error instanceof HistoryError) throw error;
    throw new HistoryError(404, '会话文件不存在或无法读取');
  }
}
export function sessionTitle(manager: SessionManager) {
  const first = manager.getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'user');
  const content = first?.type === 'message' && first.message.role === 'user' ? first.message.content : undefined;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part) => part.type === 'text').map((part) => part.text).join(' ') : '';
  return (manager.getSessionName() || text.trim() || '未命名对话').slice(0, 120);
}
export function renameHistory(manager: SessionManager, name: unknown) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || /[\u0000-\u001f]/.test(name)) throw new HistoryError(400, '会话名称需要 1–120 个字符，且不能包含控制字符');
  manager.appendSessionInfo(name.trim());
  return name.trim();
}
export function changeHistory(manager: SessionManager, action: unknown, name?: unknown) {
  const current = historyState(manager);
  switch (action) {
    case 'rename': renameHistory(manager, name); return current;
    case 'pin': current.pinned = true; break;
    case 'unpin': current.pinned = false; break;
    case 'archive': current.status = 'archived'; break;
    case 'unarchive': case 'restore': current.status = 'active'; break;
    case 'trash': current.status = 'trashed'; current.pinned = false; break;
    default: throw new HistoryError(400, '不支持的会话操作');
  }
  manager.appendCustomEntry('forge.web.history', current);
  return current;
}
export function forkable(entry: SessionEntry) {
  if (entry.type !== 'message') return false;
  if (entry.message.role === 'user') return true;
  return entry.message.role === 'assistant' && entry.message.stopReason !== 'error'
    && !entry.message.content.some((part) => part.type === 'toolCall')
    && entry.message.content.some((part) => part.type === 'text' && part.text.trim());
}
/** A disposable Pi manager owns the clone; the live source manager is never branched. */
export function forkHistory(source: SessionManager, entryId: unknown) {
  const entry = source.getBranch().find((item) => item.id === entryId);
  if (!entry || !forkable(entry)) throw new HistoryError(400, '只能从当前对话中的用户消息或完整回答建立分支');
  const sourcePath = source.getSessionFile();
  if (!sourcePath) throw new HistoryError(409, '请先保存一轮对话再分叉');
  const branch = SessionManager.open(sourcePath);
  const path = branch.createBranchedSession(entry.id);
  if (!path) throw new HistoryError(500, '无法保存会话分支');
  const target = branch.getEntry(entry.id)!;
  const message = entry.type === 'message' ? entry.message : undefined;
  // Pi's fork/editor behavior: re-edit a text prompt with only its preceding context.
  // Image prompts retain their original attachments and continue after that message.
  const edit = message?.role === 'user' && (typeof message.content === 'string' || message.content.every((part) => part.type === 'text'));
  let draft = '';
  if (edit) {
    if (target.parentId) branch.branch(target.parentId); else branch.resetLeaf();
    draft = typeof message.content === 'string' ? message.content : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  }
  const origin = { version: 1 as const, sourcePath, sourceTitle: sessionTitle(source), entryId: entry.id, kind: edit ? 'edit' as const : 'continue' as const };
  branch.appendCustomEntry('forge.web.fork', origin);
  branch.appendCustomEntry('forge.web.history', { version: 1, pinned: false, status: 'active' });
  // The prefix is historical context, not completion/verification evidence for a new task.
  branch.appendCustomEntry('pforge.task', { cleared: true });
  branch.appendCustomEntry('pforge.verification', { status: 'unchecked', attempts: 0 });
  branch.appendSessionInfo(origin.sourceTitle.slice(0, 114) + ' · 分支');
  return { path, project: branch.getCwd(), draft, origin };
}
