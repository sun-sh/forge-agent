import { describe, expect, it } from 'vitest';
import { createExecutionState, restoreTask, type TaskState } from '../src/task/controller.js';
import { executionResult, finalizeExecution, pendingExecutionState, type ExecutionFinalizer } from '../src/task/lifecycle.js';
import { TaskRegistry } from '../src/task/registry.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('shared execution finalization', () => {
  it.each(['direct', 'planned'] as const)('restores interrupted %s work with its original strategy and an accurate diagnostic', (workflow) => {
    const task = createExecutionState('Fix task', { workflow });
    const restored = restoreTask([{ type: 'custom', customType: 'pforge.task', data: task }]);
    expect(restored).toMatchObject({ workflow, status: 'interrupted' });
    expect(restored?.error).toContain(workflow === 'direct' ? '保留自适应执行策略' : '从只读检查重新开始');
  });
  it('keeps adaptive intent hints out of execution phases and completion gates', () => {
    for (const prompt of ['Inspect and fix login, do not modify tests', 'Run tests, then finish the requested work']) {
      const task = createExecutionState(prompt, { workflow: 'direct', mode: 'agent' });
      expect(task).toMatchObject({ kind: 'undetermined', phase: 'implement' });
      expect(task.intentHint).toMatch(/explore|verify/);
      task.verification = { status: 'passed', attempts: 0, evidence: { freshness: 'stale', configHash: 'a'.repeat(64), workspace: { version: 1, scope: 'git', files: 1, digest: 'b'.repeat(64) } } };
      expect(executionResult(task, { outcome: 'completed' }).status).toBe('needs_attention');
      task.verification = undefined;
      expect(executionResult(task, { outcome: 'completed' }, { pendingProposals: true }).status).toBe('needs_attention');
    }
  });
  it('keeps a model-completed run pending in durable and public state until host finalization succeeds', () => {
    const task = createExecutionState('Fix task', { workflow: 'planned' }); task.status = 'completed';
    const pending = pendingExecutionState(task, true)!;
    expect(pending).toMatchObject({ status: 'running', finalization: 'pending' }); expect(task.status).toBe('completed');
    expect(restoreTask([{ type: 'custom', customType: 'pforge.task', data: pending }])?.status).toBe('interrupted');
    expect(pendingExecutionState({ ...task, finalization: 'succeeded' }, true)?.status).toBe('completed');
  });
  it.each(['direct', 'planned'] as const)('retains passing verification but rejects %s success with host errors', (workflow) => {
    const task = createExecutionState('Fix task', { workflow }); task.status = 'completed';
    task.verification = { status: 'passed', attempts: 0 };
    expect(executionResult(task, { outcome: 'failed', error: 'child cleanup failed' })).toMatchObject({ status: 'failed', error: 'child cleanup failed', verification: { status: 'passed' } });
    expect(executionResult(task, { outcome: 'completed' }, { finalizationError: 'checkpoint seal failed' })).toMatchObject({ status: 'failed', finalization: 'failed', verification: { status: 'passed' } });
  });
  it.each(['prepare', 'pendingProposals', 'seal', 'restore', 'persist', 'flush'] as const)('reports %s failures and always attempts mode restoration', async (stage) => {
    let task = createExecutionState('Fix task', { workflow: 'direct' }); task.status = 'completed';
    const observed: string[] = [], saved: TaskState[] = [];
    const hit = (name: string) => { observed.push(name); if (name === stage && observed.filter((item) => item === name).length === 1) throw new Error(name + ' fault'); };
    const host: ExecutionFinalizer = { current: () => task, signals: () => ({ outcome: 'completed' }),
      async prepare() { hit('prepare'); }, async pendingProposals() { hit('pendingProposals'); return false; }, async seal() { hit('seal'); }, restore() { hit('restore'); },
      persist(value) { task = value; saved.push(value); hit('persist'); }, async flush() { hit('flush'); } };
    const final = await finalizeExecution(host);
    expect(final.task).toMatchObject({ status: 'failed', finalization: 'failed' }); expect(final.error).toContain(stage + ' fault');
    expect(observed).toContain('restore'); expect(saved.at(-1)?.status).toBe('failed');
  });
  it('coalesces superseded pending index writes and records actual write volume', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-index-coalesce-')), registry = await TaskRegistry.open(home);
    try {
      const task = createExecutionState('Fix task', { workflow: 'direct' });
      for (let i = 0; i < 50; i++) registry.save({ ...task, repairs: i % 2 }, { project: home, sessionFile: join(home, 'session.jsonl') });
      await registry.flush();
      expect(registry.persistenceStats).toMatchObject({ requestedWrites: 50, committedWrites: 1 });
      const content = await readFile(join(home, 'tasks', 'index.json'), 'utf8');
      expect(registry.persistenceStats.bytesWritten).toBe(Buffer.byteLength(content)); expect(JSON.parse(content).tasks[0].state.repairs).toBe(1);
    } finally { await registry.close(); }
  });
});
