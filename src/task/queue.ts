import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { directoryKey } from '../project-identity.js';
import { replaceMetadataFile } from './persistence.js';

const jobSchema = z.object({
  id: z.uuid(), project: z.string().min(1).max(4096), sessionFile: z.string().min(1).max(4096), title: z.string().max(300),
  prompt: z.string().min(1).max(100_000), workflow: z.enum(['direct', 'planned']), model: z.string().min(1).max(512), thinkingLevel: z.string().max(32),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']),
  createdAt: z.string(), startedAt: z.string().optional(), endedAt: z.string().optional(), error: z.string().max(2000).optional(), retryOf: z.uuid().optional()
}).strict();
export type QueuedJob = z.infer<typeof jobSchema>;
export class QueueError extends Error { constructor(public readonly status: number, message: string) { super(message); } }
export class QueueDeferredError extends Error {}
type Input = Pick<QueuedJob, 'project' | 'sessionFile' | 'title' | 'prompt' | 'workflow' | 'model' | 'thinkingLevel'>;
export const TASK_QUEUE_CONCURRENCY = 3;

/** FIFO per project/session, bounded parallel admission across projects. Pi owns execution. */
export class TaskQueue {
  private jobs: QueuedJob[] = [];
  private savedJobs: QueuedJob[] = [];
  private write = Promise.resolve();
  private active = new Map<string, { task: Promise<void>; project: string; session: string; controller: AbortController }>();
  private dispatching?: Promise<void>;
  private cancelled = new Set<string>();
  private waiting = new Set<string>();
  private stopped = true;
  private timer?: ReturnType<typeof setTimeout>;
  private error?: string;
  private constructor(private path: string, private execute: (job: QueuedJob, signal: AbortSignal) => Promise<void>, private ready: (job: QueuedJob) => boolean | Promise<boolean>) {}
  static async open(home: string, execute: (job: QueuedJob, signal: AbortSignal) => Promise<void>, ready: (job: QueuedJob) => boolean | Promise<boolean> = () => true) {
    const directory = join(home, 'tasks'); await mkdir(directory, { recursive: true });
    const queue = new TaskQueue(join(directory, 'queue.json'), execute, ready);
    try {
      queue.jobs = z.object({ version: z.literal(1), jobs: z.array(jobSchema).max(500) }).strict().parse(JSON.parse(await readFile(queue.path, 'utf8'))).jobs;
      for (const job of queue.jobs) if (job.status === 'running') { job.status = 'interrupted'; job.endedAt = new Date().toISOString(); job.error = '执行进程已退出。请检查项目后明确重新排队，不会重放上次操作。'; }
      await queue.persist();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new QueueError(500, '后台队列不可读，原始文件已保留，请先检查 tasks/queue.json'); }
    return queue;
  }
  private persist() {
    const snapshot = structuredClone(this.jobs), value = JSON.stringify({ version: 1, jobs: snapshot }) + '\n';
    const next = this.write.then(async () => { const temporary = this.path + '.' + randomUUID() + '.tmp'; await writeFile(temporary, value, { mode: 0o600 }); await replaceMetadataFile(temporary, this.path); this.savedJobs = snapshot; });
    this.write = next.catch((error) => { this.error = '队列保存失败：' + (error instanceof Error ? error.message : String(error)); this.stopped = true; });
    return next;
  }
  snapshot(project?: string) { return { jobs: structuredClone(this.savedJobs.filter((job) => !project || directoryKey(job.project) === directoryKey(project))).map(({ prompt: _prompt, ...job }) => ({ ...job, ...(job.status === 'queued' && this.waiting.has(job.id) ? { waiting: '等待项目、会话或资源空闲；同项目按顺序执行。' } : {}) })), scheduler: { concurrency: TASK_QUEUE_CONCURRENCY, running: this.savedJobs.filter((job) => job.status === 'running').length, queued: this.savedJobs.filter((job) => job.status === 'queued').length }, diagnostic: this.error }; }
  async enqueue(input: Input & { retryOf?: string }) {
    if (this.error) throw new QueueError(500, this.error);
    if (this.jobs.filter((job) => ['queued', 'running', 'interrupted'].includes(job.status)).length >= 100) throw new QueueError(409, '待处理任务最多 100 个，请先处理已有任务');
    const job = jobSchema.parse({ ...input, id: randomUUID(), status: 'queued', createdAt: new Date().toISOString() });
    this.jobs = [...this.jobs.filter((item) => !['completed', 'failed', 'cancelled'].includes(item.status)).slice(-400), ...this.jobs.filter((item) => ['completed', 'failed', 'cancelled'].includes(item.status)).slice(-99), job];
    await this.persist(); this.kick(); return structuredClone(job);
  }
  async cancel(id: string) {
    const job = this.jobs.find((item) => item.id === id);
    if (job?.status === 'running') {
      if (!this.active.has(id)) throw new QueueError(409, '任务正在切换状态，请稍后重试');
      this.cancelled.add(id);
      this.active.get(id)!.controller.abort(); await this.active.get(id)?.task; return;
    }
    if (!job || !['queued', 'interrupted'].includes(job.status)) throw new QueueError(409, '只能取消排队中或已中断的任务；运行中请停止对应会话');
    job.status = 'cancelled'; job.endedAt = new Date().toISOString(); await this.persist(); this.kick();
  }
  async retry(id: string) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || !['interrupted', 'failed', 'cancelled'].includes(job.status)) throw new QueueError(409, '当前任务不需要重新排队');
    if (this.jobs.some((item) => item.retryOf === id && ['queued', 'running'].includes(item.status))) throw new QueueError(409, '此任务已经重新排队');
    const { project, sessionFile, title, prompt, workflow, model, thinkingLevel } = job;
    return this.enqueue({ project, sessionFile, title, prompt, workflow, model, thinkingLevel, retryOf: id });
  }
  start() { this.stopped = false; this.kick(); }
  private kick() {
    if (this.stopped || this.dispatching || this.timer || this.active.size >= TASK_QUEUE_CONCURRENCY) return;
    this.timer = setTimeout(() => { this.timer = undefined; if (this.stopped) return; this.dispatching = this.drain().catch((error) => { this.error = '队列调度失败：' + (error instanceof Error ? error.message : String(error)); this.stopped = true; }).finally(() => { this.dispatching = undefined; if (!this.stopped && this.jobs.some((job) => job.status === 'queued')) this.kick(); }); }, 300);
    this.timer.unref();
  }
  private async drain() {
    const projects = new Set([...this.active.values()].map((run) => run.project)), sessions = new Set([...this.active.values()].map((run) => run.session));
    for (const job of this.jobs) {
      if (this.stopped || this.active.size >= TASK_QUEUE_CONCURRENCY) break;
      if (job.status !== 'queued') continue;
      const project = directoryKey(await realpath(job.project).catch(() => resolve(job.project))), session = directoryKey(resolve(job.sessionFile));
      const occupied = projects.has(project) || sessions.has(session);
      // Reserve the oldest queued position even when an external owner is busy.
      projects.add(project); sessions.add(session);
      if (occupied) { this.waiting.add(job.id); continue; }
      let ready: boolean;
      try { ready = await this.ready(structuredClone(job)); }
      catch (error) {
        // A deleted/unreadable project must fail its own job, not the scheduler.
        if (job.status !== 'queued') continue;
        job.status = 'failed'; job.endedAt = new Date().toISOString();
        job.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
        this.waiting.delete(job.id); await this.persist(); continue;
      }
      if (!ready) { this.waiting.add(job.id); continue; }
      if (this.stopped || job.status !== 'queued') continue;
      this.waiting.delete(job.id);
      const controller = new AbortController();
      const task = this.run(job, controller.signal).finally(() => { this.active.delete(job.id); this.cancelled.delete(job.id); this.kick(); });
      this.active.set(job.id, { task, project, session, controller });
    }
  }
  private async run(job: QueuedJob, signal: AbortSignal) {
    job.status = 'running'; job.startedAt = new Date().toISOString();
    try {
      await this.persist();
      if (this.cancelled.has(job.id)) { job.status = 'cancelled'; return; }
      if (this.stopped) { job.status = 'interrupted'; job.error = '服务正在停止，任务未启动；请检查后明确重新排队。'; return; }
      await this.execute(structuredClone(job), signal); job.status = this.cancelled.has(job.id) ? 'cancelled' : 'completed';
    }
    catch (error) {
      if (error instanceof QueueDeferredError && !this.cancelled.has(job.id) && !this.stopped) { job.status = 'queued'; delete job.startedAt; delete job.error; this.waiting.add(job.id); }
      else { job.status = this.cancelled.has(job.id) ? 'cancelled' : this.stopped ? 'interrupted' : 'failed'; job.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000); }
    }
    finally { if (job.status !== 'queued') job.endedAt = new Date().toISOString(); await this.persist().catch(() => {}); }
  }
  stopAdmission() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  async close() { this.stopAdmission(); await this.dispatching; await Promise.all([...this.active.values()].map((run) => run.task)); await this.write; }
}
