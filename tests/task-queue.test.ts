import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TaskQueue } from '../src/task/queue.js';
const input = { project: '/project', sessionFile: '/sessions/a.jsonl', title: 'Task', prompt: 'Fix a bug', workflow: 'direct' as const, model: 'test/model', thinkingLevel: 'off' };
describe('durable FIFO admission', () => {
  it('never executes or publishes success when the running transition cannot persist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-queue-storage-')), execute = vi.fn();
    const queue = await TaskQueue.open(home, execute);
    try {
      const job = await queue.enqueue(input), path = join(home, 'tasks', 'queue.json');
      await rename(path, path + '.backup'); await mkdir(path);
      queue.start(); await vi.waitFor(() => expect(queue.snapshot().diagnostic).toContain('保存失败'));
      expect(execute).not.toHaveBeenCalled(); expect(queue.snapshot().jobs[0]).toMatchObject({ id: job.id, status: 'queued' });
      await expect(queue.enqueue(input)).rejects.toMatchObject({ status: 500 });
    } finally { await queue.close(); }
  });
  it('requeues an interrupted job only after an explicit retry and preserves its frozen settings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-queue-retry-')); await mkdir(join(home, 'tasks'));
    const id = randomUUID(); await writeFile(join(home, 'tasks', 'queue.json'), JSON.stringify({ version: 1, jobs: [{ ...input, id, status: 'running', createdAt: new Date().toISOString() }] }));
    const execute = vi.fn(), queue = await TaskQueue.open(home, execute);
    try {
      const retried = await queue.retry(id);
      expect(retried).toMatchObject({ ...input, retryOf: id, status: 'queued' });
      expect(retried.id).not.toBe(id); await expect(queue.retry(id)).rejects.toMatchObject({ status: 409 });
      expect(execute).not.toHaveBeenCalled();
      queue.start(); await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(queue.snapshot().jobs.find((job) => job.id === retried.id)?.status).toBe('completed'));
    } finally { await queue.close(); }
  });
  it('persists before execution and serializes jobs while respecting admission readiness', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-queue-')), seen: string[] = []; let ready = false, active = 0;
    const queue = await TaskQueue.open(home, async (job) => {
      expect(JSON.parse(await readFile(join(home, 'tasks', 'queue.json'), 'utf8')).jobs.find((item: any) => item.id === job.id).status).toBe('running');
      expect(++active).toBe(1); seen.push(job.id); await new Promise((done) => setTimeout(done, 20)); active--;
    }, () => ready);
    try {
      const first = await queue.enqueue(input), second = await queue.enqueue({ ...input, prompt: 'Second' }); queue.start();
      await new Promise((done) => setTimeout(done, 400)); expect(seen).toEqual([]);
      ready = true; await vi.waitFor(() => expect(queue.snapshot().jobs.map((job) => job.status)).toEqual(['completed', 'completed']), { timeout: 5000 });
      expect(seen).toEqual([first.id, second.id]); expect(JSON.stringify(queue.snapshot())).not.toContain('Fix a bug');
    } finally { await queue.close(); }
  });
  it('marks previously running jobs interrupted and never automatically replays them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-queue-restart-')); await mkdir(join(home, 'tasks'));
    const id = randomUUID(); await writeFile(join(home, 'tasks', 'queue.json'), JSON.stringify({ version: 1, jobs: [{ ...input, id, status: 'running', createdAt: new Date().toISOString() }] }));
    const execute = vi.fn(), queue = await TaskQueue.open(home, execute); queue.start();
    try { await new Promise((done) => setTimeout(done, 400)); expect(execute).not.toHaveBeenCalled(); expect(queue.snapshot().jobs[0]).toMatchObject({ id, status: 'interrupted' }); await queue.cancel(id); }
    finally { await queue.close(); }
  });
  it('preserves failures, cancellation and invalid persistence without claiming completion', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-queue-failure-')), queue = await TaskQueue.open(home, async () => { throw new Error('verification failed'); });
    const first = await queue.enqueue(input), cancelled = await queue.enqueue(input); await queue.cancel(cancelled.id); queue.start();
    try { await vi.waitFor(() => expect(queue.snapshot().jobs.find((job) => job.id === first.id)?.status).toBe('failed')); expect(queue.snapshot().jobs[0]?.error).toContain('verification failed'); }
    finally { await queue.close(); }
    const path = join(home, 'tasks', 'queue.json'); await writeFile(path, '{bad');
    await expect(TaskQueue.open(home, vi.fn())).rejects.toThrow('原始文件'); expect(await readFile(path, 'utf8')).toBe('{bad');
  });
});
