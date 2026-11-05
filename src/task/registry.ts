import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  private constructor(private readonly path: string) {}

  static async open(home: string): Promise<TaskRegistry> {
    const directory = join(home, 'tasks');
    await mkdir(directory, { recursive: true });
    const registry = new TaskRegistry(join(directory, 'index.json'));
    try {
      const raw = await readFile(registry.path, 'utf8');
      const parsed = registrySchema.safeParse(JSON.parse(raw));
      if (parsed.success) for (const item of parsed.data.tasks) registry.records.set(item.id, clone(item));
    } catch {
      // A missing or malformed registry must not prevent the agent from
      // opening Pi sessions. The session transcript remains the source of
      // truth and will repopulate the index when the task is next opened.
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
  }

  private scheduleWrite() {
    const snapshot = { version: 1 as const, tasks: [...this.records.values()].map(clone) };
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = this.path + '.tmp';
      await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
    }).catch(() => {
      // Persistence is best effort for the live request. The Pi session file
      // is still written by SessionManager and remains the recovery source.
    });
  }

  save(state: TaskState, metadata: { project: string; sessionFile: string; sessionId?: string }) {
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

  async flush() { await this.writeQueue; }
}
