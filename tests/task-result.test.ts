import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionState, restoreTask, type TaskState } from '../src/task/controller.js';
import { publicTask, taskResult } from '../src/task/result.js';
import { TaskRegistry } from '../src/task/registry.js';

const verification = () => ({
  status: 'passed' as const, attempts: 0, evidenceId: randomUUID(),
  evidence: { freshness: 'current' as const, configHash: 'a'.repeat(64), workspace: { version: 1 as const, scope: 'git' as const, files: 1, digest: 'b'.repeat(64) } },
  report: { passed: true, summary: 'PASS', results: [{ name: 'syntax', command: 'python -m py_compile app.py', exitCode: 0, passed: true, durationMs: 1, output: 'syntax ok' }] }
});
function implemented(workflow: 'direct' | 'planned' = 'direct'): TaskState {
  const task = createExecutionState('Fix the behavior', { workflow, mode: 'agent' });
  task.kind = 'change'; task.status = 'completed'; task.phase = 'complete'; task.finalization = 'succeeded';
  task.artifacts = [{ path: 'app.py', operation: 'edit' }]; task.verification = verification();
  return task;
}

describe('execution results without unsupported resolution claims', () => {
  it('does not promote configured checks, their names, or model review into behavioral acceptance', () => {
    for (const command of ['python -m py_compile app.py', 'pytest tests/test_behavior.py', 'npm test']) {
      const task = implemented('planned'); task.verification!.report!.results[0]!.command = command;
      task.review = { verdict: 'ready', summary: 'Looks good', issues: [], acceptance: [], freshness: 'current', evidenceId: task.verification!.evidenceId };
      expect(taskResult(task)).toEqual({ version: 1, status: 'implemented_unverified', execution: 'finished', acceptance: 'unverified', resolutionClaimed: false, checks: 'passed', modelReview: 'passed' });
    }
  });
  it('uses not-applicable review semantics for planned-no-review', () => {
    const task = implemented('planned'); task.reviewRequired = false;
    expect(taskResult(task)).toMatchObject({ status: 'implemented_unverified', acceptance: 'unverified', modelReview: 'not_applicable', resolutionClaimed: false });
  });
  it('finishes an implementation without configured checks without reopening its execution', () => {
    const task = implemented(); task.verification = { status: 'skipped', attempts: 0, reason: 'No verification commands configured.' };
    expect(taskResult(task)).toMatchObject({ status: 'implemented_unverified', execution: 'finished', checks: 'not_configured', resolutionClaimed: false });
    expect(task.status).toBe('completed');
  });
  it('keeps failure, finalization, protection and evidence freshness gates visible', () => {
    const task = implemented('planned');
    expect(taskResult(task).status).toBe('blocked'); // Required review has not happened.
    task.workflow = 'direct';
    for (const status of ['failed', 'needs_attention', 'budget_exceeded', 'aborted', 'interrupted'] as const) expect(taskResult({ ...task, status }).status).toBe('blocked');
    expect(taskResult({ ...task, finalization: 'failed' }).status).toBe('blocked');
    expect(taskResult({ ...task, verification: { ...task.verification!, evidence: { ...task.verification!.evidence!, freshness: 'stale' } } })).toMatchObject({ status: 'blocked', checks: 'unconfirmed' });
    expect(taskResult({ ...task, verification: { ...task.verification!, protection: { status: 'changed', complete: true, changes: [], paths: [] } as any } }).status).toBe('blocked');
    expect(taskResult({ ...task, status: 'interrupted', finalization: 'pending' }).status).toBe('blocked');
    expect(taskResult({ ...task, status: 'running', finalization: 'pending' })).toMatchObject({ status: 'in_progress', execution: 'running', resolutionClaimed: false });
  });
  it('does not claim implementation for answers or for adaptive turns with no observed change', () => {
    const task = implemented(); task.kind = 'undetermined'; task.artifacts = []; task.changes = { available: true, truncated: false, files: [] };
    expect(taskResult(task).status).toBe('finished_unverified');
    for (const mode of ['ask', 'plan']) expect(taskResult({ ...task, mode })).toMatchObject({ status: 'not_applicable', acceptance: 'not_applicable', resolutionClaimed: false });
    expect(taskResult({ ...task, kind: 'verify' }).status).toBe('not_applicable');
  });
  it('recomputes legacy/forged result flags instead of persisting a new success claim', async () => {
    const task = implemented(), legacy = { ...task, result: { status: 'completed', resolutionClaimed: true } };
    const projected = publicTask(legacy);
    expect(projected.result).toMatchObject({ status: 'implemented_unverified', resolutionClaimed: false });
    expect(legacy.result.resolutionClaimed).toBe(true);
    const restored = restoreTask([{ type: 'custom', customType: 'pforge.task', data: legacy }])!;
    expect(publicTask(restored).result.resolutionClaimed).toBe(false);
    const home = await mkdtemp(join(tmpdir(), 'forge-result-registry-'));
    const registry = await TaskRegistry.open(home);
    registry.save(task, { project: home, sessionFile: join(home, 'task.jsonl') }); await registry.flush(); await registry.close();
    const reopened = await TaskRegistry.open(home);
    try { expect(publicTask(reopened.get(task.id)!.state).result).toEqual(taskResult(task)); }
    finally { await reopened.close(); }
  });
});
