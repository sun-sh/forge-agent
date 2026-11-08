import { canonicalDirectory, directoryKey } from '../project-identity.js';

export class ProjectBusyError extends Error {
  readonly status = 409;
  constructor(message = '当前项目正在执行任务或终端命令，请先停止或等待结束') { super(message); }
}
export interface ProjectExecution {
  readonly kind: 'agent' | 'terminal' | 'trust';
  readonly signal: AbortSignal;
  readonly done: Promise<void>;
  cancel(): void;
  release(): void;
}

/** One exclusive executor per canonical project, including directory aliases. */
export class ProjectExecutions {
  private readonly active = new Map<string, ProjectExecution>();
  private closed = false;
  async isActive(project: string): Promise<boolean> { return this.active.has(directoryKey(await canonicalDirectory(project))); }
  async acquire(project: string, kind: ProjectExecution['kind']): Promise<ProjectExecution> {
    const key = directoryKey(await canonicalDirectory(project));
    // Check and reserve together, after the final await.
    if (this.closed) throw new ProjectBusyError('服务正在关闭');
    if (this.active.has(key)) throw new ProjectBusyError();
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const lease: ProjectExecution = {
      kind, signal: controller.signal, done,
      cancel: () => controller.abort(),
      release: () => { if (this.active.get(key) === lease) { this.active.delete(key); finish(); } }
    };
    this.active.set(key, lease);
    return lease;
  }
  async cancelTerminal(project: string): Promise<boolean> {
    const lease = this.active.get(directoryKey(await canonicalDirectory(project)));
    if (lease?.kind !== 'terminal') return false;
    lease.cancel(); await lease.done; return true;
  }
  async close(): Promise<void> {
    this.closed = true;
    const leases = [...this.active.values()];
    for (const lease of leases) lease.cancel();
    await Promise.all(leases.map((lease) => lease.done));
  }
}
