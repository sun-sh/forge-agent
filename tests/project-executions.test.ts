import { describe, expect, it } from 'vitest';
import { mkdtemp, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectExecutions } from '../src/web/executions.js';

describe('project execution ownership', () => {
  it('serializes agent, terminal and trust work for the same real directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-execution-'));
    const alias = join(root, 'alias');
    try { await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir'); } catch { return; }
    const executions = new ProjectExecutions();
    const first = await executions.acquire(root, 'agent');
    await expect(executions.acquire(alias, 'terminal')).rejects.toThrow('项目正在执行');
    first.release();
    const second = await executions.acquire(alias, 'terminal');
    expect(second.kind).toBe('terminal');
    second.release();
    await executions.close();
  });

  it('cancels active work when the service closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-execution-close-'));
    const executions = new ProjectExecutions();
    const lease = await executions.acquire(root, 'terminal');
    const released = new Promise<void>((resolve) => lease.signal.addEventListener('abort', () => { lease.release(); resolve(); }, { once: true }));
    await executions.close();
    await released;
    expect(lease.signal.aborted).toBe(true);
  });
});
