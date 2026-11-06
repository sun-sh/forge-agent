import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { taskStateSchema, type TaskState } from './controller.js';

const MAX_TASKS = 500;
const registrySchema = z.object({
  version: z.literal(1),
  tasks: z.array(z.object({
    version: z.literal(1),
    id: z.uuid(),
    project: z.string().min(1).max(4096),
    sessionFile: z.string().min(1).max(4096),
    sessionId: z.string().min(1).max(128).optional(),
    state: taskStateSchema
  }).strict()).max(MAX_TASKS)
}).strict();

export type TaskRecord = {
  version: 1;
  id: string;
  project: string;
  sessionFile: string;
  sessionId?: string;
  state: TaskState;
};

function clone<T>(value: T): T { return structuredClone(value); }

/**
 * Durable metadata for host-orchestrated tasks. Pi remains authoritative for
 * the transcript and model turns; this index only makes task discovery and
 * recovery possible after a browser or Web gateway restart.
 */
export class TaskRegistry {
  private readonly records = new Map<string, TaskRecord>();
  private writeQueue: Promise<void> = Promise.resolve();
  private writeError?: Error;
  private warning?: string;
  private compromised = false;
  private closed = false;
  private release?: () => Promise<void>;
  private constructor(private readonly path: string, private readonly ownerPath: string) {}

  get diagnostic(): string | undefined { return this.writeError ? '任务索引保存失败：' + this.writeError.message : this.warning; }

  static async open(home: string, onCompromised?: (error: Error) => void): Promise<TaskRegistry> {
    const directory = join(home, 'tasks');
    await mkdir(directory, { recursive: true });
    const registry = new TaskRegistry(join(directory, 'index.json'), join(directory, 'web-owner.json'));
    try {
      registry.release = await lockfile.lock(directory, {
        lockfilePath: join(directory, 'web-owner.lock'), stale: 30000, update: 5000, retries: 0,
        onCompromised(error) { registry.compromised = true; registry.writeError = error; onCompromised?.(error); }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
      let address = '';
      try {
        const owner = JSON.parse(await readFile(registry.ownerPath, 'utf8'));
        const url = new URL(owner.url);
        if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) address = '：' + url.origin;
      } catch { /* The existing owner may still be starting. Never print its token. */ }
      throw new Error('这个 Forge 数据目录已有 Web 服务在运行' + address + '。请使用现有服务，或设置独立的 FORGE_AGENT_HOME。异常退出后租约最多需要 30 秒恢复。');
    }
    try {
    await registry.setAddress();
    try {
      const raw = await readFile(registry.path, 'utf8');
      const parsed = registrySchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new SyntaxError('Invalid task index schema');
      for (const item of parsed.data.tasks) registry.records.set(item.id, clone(item));
    } catch (error) {
      if (error instanceof SyntaxError) {
        const backup = registry.path + '.invalid-' + randomUUID();
        await rename(registry.path, backup);
        registry.warning = '任务索引损坏，原文件已保留为 ' + backup + '。可从 Pi 会话历史恢复任务。';
      } else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let changed = false;
    const now = new Date().toISOString();
    for (const record of registry.records.values()) {
      if (record.state.status !== 'running') continue;
      record.state.status = 'interrupted';
      record.state.updatedAt = now;
      record.state.error = 'Forge 服务已重启。请明确继续，系统将从只读检查重新开始，不重放上次操作。';
      changed = true;
    }
    if (changed) { registry.scheduleWrite(); await registry.flush(); }
    return registry;
    } catch (error) { await registry.close().catch(() => {}); throw error; }
  }

  async setAddress(url?: string) {
    await writeFile(this.ownerPath, JSON.stringify({ pid: process.pid, ...(url ? { url: new URL(url).origin } : {}) }) + '\n', { encoding: 'utf8', mode: 0o600 });
  }

  private scheduleWrite() {
    const snapshot = { version: 1 as const, tasks: [...this.records.values()].map(clone) };
    this.writeQueue = this.writeQueue.then(async () => {
      if (this.closed || this.compromised) throw new Error('Task registry ownership was lost');
      const temporary = this.path + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, this.path);
        this.writeError = undefined;
      } finally { await rm(temporary, { force: true }); }
    }).catch((error: unknown) => { this.writeError = error instanceof Error ? error : new Error(String(error)); });
  }

  save(state: TaskState, metadata: { project: string; sessionFile: string; sessionId?: string }) {
    if (this.closed || this.compromised) throw new Error('Task registry is closed or ownership was lost');
    const record: TaskRecord = { version: 1, id: state.id, project: metadata.project, sessionFile: metadata.sessionFile, ...(metadata.sessionId ? { sessionId: metadata.sessionId } : {}), state: clone(state) };
    this.records.set(record.id, record);
    const ordered = [...this.records.values()].sort((left, right) => Date.parse(right.state.updatedAt) - Date.parse(left.state.updatedAt));
    for (const stale of ordered.slice(MAX_TASKS)) this.records.delete(stale.id);
    this.scheduleWrite();
  }

  get(id: string): TaskRecord | undefined {
    const record = this.records.get(id);
    return record ? clone(record) : undefined;
  }

  list(project?: string): TaskRecord[] {
    return [...this.records.values()]
      .filter((record) => !project || record.project === project)
      .sort((left, right) => Date.parse(right.state.updatedAt) - Date.parse(left.state.updatedAt))
      .map(clone);
  }

  async flush() { await this.writeQueue; if (this.writeError) throw this.writeError; }
  async close() {
    if (this.closed) return;
    try { await this.flush(); }
    finally {
      this.closed = true;
      if (!this.compromised) { await rm(this.ownerPath, { force: true }); await this.release?.(); }
    }
  }
}
