import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const jobSchema = z.object({
  id: z.uuid(), project: z.string().min(1).max(4096), sessionFile: z.string().min(1).max(4096), title: z.string().max(300),
  prompt: z.string().min(1).max(100_000), workflow: z.enum(['direct', 'planned']), model: z.string().min(1).max(512), thinkingLevel: z.string().max(32),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']),
  createdAt: z.string(), startedAt: z.string().optional(), endedAt: z.string().optional(), error: z.string().max(2000).optional(), retryOf: z.uuid().optional()
}).strict();
export type QueuedJob = z.infer<typeof jobSchema>;
export class QueueError extends Error { constructor(public readonly status: number, message: string) { super(message); } }
type Input = Pick<QueuedJob, 'project' | 'sessionFile' | 'title' | 'prompt' | 'workflow' | 'model' | 'thinkingLevel'>;

/** Durable FIFO admission only; execute delegates every model/tool turn to Pi. */
export class TaskQueue {
  private jobs: QueuedJob[] = [];
  private savedJobs: QueuedJob[] = [];
  private write = Promise.resolve();
  private active?: Promise<void>;
  private stopped = true;
  private timer?: ReturnType<typeof setTimeout>;
  private error?: string;
  private constructor(private path: string, private execute: (job: QueuedJob) => Promise<void>, private ready: () => boolean) {}
  static async open(home: string, execute: (job: QueuedJob) => Promise<void>, ready = () => true) {
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
    const next = this.write.then(async () => { const temporary = this.path + '.' + randomUUID() + '.tmp'; await writeFile(temporary, value, { mode: 0o600 }); await rename(temporary, this.path); this.savedJobs = snapshot; });
    this.write = next.catch((error) => { this.error = '队列保存失败：' + (error instanceof Error ? error.message : String(error)); this.stopped = true; });
    return next;
  }
  snapshot(project?: string) { return { jobs: structuredClone(this.savedJobs.filter((job) => !project || job.project === project)).map(({ prompt: _prompt, ...job }) => job), diagnostic: this.error }; }
  async enqueue(input: Input & { retryOf?: string }) {
    if (this.error) throw new QueueError(500, this.error);
    if (this.jobs.filter((job) => ['queued', 'running', 'interrupted'].includes(job.status)).length >= 100) throw new QueueError(409, '待处理任务最多 100 个，请先处理已有任务');
    const job = jobSchema.parse({ ...input, id: randomUUID(), status: 'queued', createdAt: new Date().toISOString() });
    this.jobs = [...this.jobs.filter((item) => !['completed', 'failed', 'cancelled'].includes(item.status)).slice(-400), ...this.jobs.filter((item) => ['completed', 'failed', 'cancelled'].includes(item.status)).slice(-99), job];
    await this.persist(); this.kick(); return structuredClone(job);
  }
  async cancel(id: string) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || !['queued', 'interrupted'].includes(job.status)) throw new QueueError(409, '只能取消排队中或已中断的任务；运行中请停止对应会话');
    job.status = 'cancelled'; job.endedAt = new Date().toISOString(); await this.persist();
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
    if (this.stopped || this.active || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; if (this.stopped) return; this.active = this.drain().finally(() => { this.active = undefined; if (!this.stopped && this.jobs.some((job) => job.status === 'queued')) this.kick(); }); }, 300);
    this.timer.unref();
  }
  private async drain() {
    if (!this.ready()) return;
    const job = this.jobs.find((item) => item.status === 'queued'); if (!job) return;
    job.status = 'running'; job.startedAt = new Date().toISOString();
    try { await this.persist(); await this.execute(structuredClone(job)); job.status = 'completed'; }
    catch (error) { job.status = this.stopped ? 'interrupted' : 'failed'; job.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000); }
    finally { job.endedAt = new Date().toISOString(); await this.persist().catch(() => {}); }
  }
  stopAdmission() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  async close() { this.stopAdmission(); await this.active; await this.write; }
}
