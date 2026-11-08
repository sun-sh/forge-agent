import { mkdtemp, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { QueueDeferredError, TaskQueue } from '../src/task/queue.js';
const input = { project: '/project', sessionFile: '/sessions/a.jsonl', title: 'Task', prompt: 'Fix a bug', workflow: 'direct' as const, model: 'test/model', thinkingLevel: 'off' };
describe('durable FIFO admission', () => {
  it('serializes directory aliases and fails only the job whose readiness cannot be checked', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-queue-alias-')), project = join(home, 'project'), alias = join(home, 'alias');
    await mkdir(project); await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const seen: string[] = [], releases = new Map<string, () => void>();
    const queue = await TaskQueue.open(home, (job) => new Promise<void>((done) => { seen.push(job.title); releases.set(job.title, done); }), (job) => { if (job.title === 'deleted') throw new Error('Project no longer exists'); return true; });
    try {
      await queue.enqueue({ ...input, title: 'deleted', project: join(home, 'missing') });
      await queue.enqueue({ ...input, title: 'original', project, sessionFile: '/s/one' });
      await queue.enqueue({ ...input, title: 'alias', project: alias, sessionFile: '/s/two' });
      await queue.enqueue({ ...input, title: 'independent', project: join(home, 'other'), sessionFile: '/s/three' });
      queue.start(); await vi.waitFor(() => expect(seen).toEqual(['original', 'independent']));
      expect(queue.snapshot().jobs.find((job) => job.title === 'deleted')).toMatchObject({ status: 'failed', error: 'Project no longer exists' });
      expect(queue.snapshot().diagnostic).toBeUndefined(); releases.get('original')!();
      await vi.waitFor(() => expect(seen).toContain('alias'));
    } finally { queue.stopAdmission(); releases.forEach((release) => release()); await queue.close(); }
  });
  it('runs three independent projects concurrently while preserving per-project order and skipping busy projects', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-queue-parallel-')), seen: string[] = [], releases = new Map<string, () => void>();
    let externallyBusy = true;
    const queue = await TaskQueue.open(home, (job) => new Promise<void>((done) => { seen.push(job.title); releases.set(job.title, done); }), (job) => job.project !== '/busy' || !externallyBusy);
    try {
      await queue.enqueue({ ...input, project: '/busy', sessionFile: '/s/busy', title: 'busy' });
      for (const [project, title] of [['/a', 'a1'], ['/a', 'a2'], ['/b', 'b1'], ['/c', 'c1'], ['/d', 'd1']]) await queue.enqueue({ ...input, project: project!, sessionFile: '/s/' + project, title: title! });
      queue.start(); await vi.waitFor(() => expect(seen).toEqual(['a1', 'b1', 'c1']));
      expect(queue.snapshot().scheduler).toMatchObject({ concurrency: 3, running: 3 });
      expect(queue.snapshot().jobs.find((job) => job.title === 'busy')?.waiting).toContain('等待');
      releases.get('a1')!(); await vi.waitFor(() => expect(seen).toContain('a2')); expect(seen).not.toContain('d1');
      externallyBusy = false; releases.get('b1')!(); await vi.waitFor(() => expect(seen).toContain('busy'));
      releases.get('c1')!(); await vi.waitFor(() => expect(seen).toContain('d1'));
    } finally { queue.stopAdmission(); releases.forEach((release) => release()); await queue.close(); }
  });

  it('cancels one running project through its signal without cancelling another project', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-queue-cancel-')); const releases: Array<() => void> = [];
    const queue = await TaskQueue.open(home, (_job, signal) => new Promise<void>((done) => { releases.push(done); signal.addEventListener('abort', () => done(), { once: true }); }));
    try {
      const first = await queue.enqueue({ ...input, project: '/a', sessionFile: '/s/a' }), second = await queue.enqueue({ ...input, project: '/b', sessionFile: '/s/b' }); queue.start();
      await vi.waitFor(() => expect(releases).toHaveLength(2)); await queue.cancel(first.id);
      expect(queue.snapshot().jobs.find((job) => job.id === first.id)?.status).toBe('cancelled');
      expect(queue.snapshot().jobs.find((job) => job.id === second.id)?.status).toBe('running');
      releases[1]!(); await vi.waitFor(() => expect(queue.snapshot().jobs.find((job) => job.id === second.id)?.status).toBe('completed'));
    } finally { releases.forEach((release) => release()); await queue.close(); }
  });

  it('defers an ownership race without replaying a started task or marking it failed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-queue-defer-')); let attempts = 0;
    const queue = await TaskQueue.open(home, async () => { if (++attempts === 1) throw new QueueDeferredError('Project became busy before launch'); });
    try {
      const job = await queue.enqueue(input); queue.start();
      await vi.waitFor(() => expect(queue.snapshot().jobs.find((item) => item.id === job.id)?.status).toBe('completed'));
      expect(attempts).toBe(2); expect(queue.snapshot().jobs[0]!.error).toBeUndefined();
    } finally { await queue.close(); }
  });

  it('never executes or publishes success when the running transition cannot persist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-queue-storage-')), execute = vi.fn();
    const queue = await TaskQueue.open(home, execute);
    try {
      const job = await queue.enqueue(input), path = join(home, 'tasks', 'queue.json');
      await rename(path, path + '.backup'); await mkdir(path);
      queue.start(); await vi.waitFor(() => expect(queue.snapshot().diagnostic).toContain('保存失败'), { timeout: 5000 });
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
