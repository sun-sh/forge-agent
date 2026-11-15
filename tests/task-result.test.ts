import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionState, restoreTask, type TaskState } from '../src/task/controller.js';
import { publicTask, taskResult, taskResultSchema } from '../src/task/result.js';
import { TaskRegistry } from '../src/task/registry.js';
import { beginBehaviorRun, behaviorHash, newBehaviorState, settleBehaviorRun, type BehaviorPlan, type BehaviorReceipt } from '../src/task/behavior.js';

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

  it('runtime-validates the closed result enum and rejects undocumented values', () => {
    const task = implemented('planned'); task.reviewRequired = false;
    const result = taskResult(task);
    expect(taskResultSchema.parse(result)).toEqual(result);
    expect(() => taskResultSchema.parse({ ...result, modelReview: 'new_status' })).toThrow();
    expect(() => taskResultSchema.parse({ ...result, resolutionClaimed: true })).toThrow();
    expect(publicTask({ ...task, result: { status: 'future' } } as any).result).toEqual(result);
  });

function calibrated() {
  const task = implemented('planned'); task.reviewRequired = false;
  const plan: BehaviorPlan = { version: 1, status: 'ready', summary: 'Focused checks', assumptions: [], unresolved: [], checks: [
    { id: 'B1', kind: 'reproduction', requestQuote: task.prompt, expectation: 'Trigger works', command: 'node trigger.js', shell: 'bash', timeoutSeconds: 60 },
    { id: 'B2', kind: 'boundary', requestQuote: task.prompt, expectation: 'Boundary works', command: 'node boundary.js', shell: 'bash', timeoutSeconds: 60 }
  ] };
  const stamp = task.verification!.evidence!.workspace;
  const receipt = (runId: string, index: number, exitCode: number): BehaviorReceipt => {
    const check = plan.checks[index]!, output = exitCode ? 'original failure' : 'native success';
    return { version: 1, runId, checkId: check.id, toolCallId: randomUUID(), tool: check.shell, commandSha256: behaviorHash(check.command), source: 'pi-builtin-shell', exitCode, status: exitCode ? 'failed' : 'passed', output, outputSha256: behaviorHash(output), outputCharacters: output.length, truncated: false, recordedAt: task.updatedAt };
  };
  let state = beginBehaviorRun({ ...newBehaviorState(task.prompt), plan }, stamp, 'baseline');
  state.receipts = [receipt(state.runId!, 0, 1), receipt(state.runId!, 1, 0)];
  state = settleBehaviorRun(state, stamp); state.calibration!.implementationStarted = true;
  state = beginBehaviorRun(state, stamp, 'candidate');
  state.receipts = [receipt(state.runId!, 0, 0), receipt(state.runId!, 1, 0)];
  task.behavior = settleBehaviorRun(state, stamp);
  return task;
}

describe('behavior calibration result projection', () => {
  it('derives comparisons from native receipts instead of cached flags without upgrading acceptance', () => {
    const task = calibrated();
    expect(task.behavior!.runWorkspace).toEqual(task.behavior!.workspace);
    expect(task.behavior!.checkedAt).toEqual(expect.any(String));
    task.behavior!.calibration!.comparisons = [{ checkId: 'B1', outcome: 'pre_existing_failure', sameOutput: true }];
    const saved = structuredClone(task), result = taskResult(task);
    expect(result).toMatchObject({ behaviorChecks: 'passed', acceptance: 'unverified', resolutionClaimed: false, behaviorCalibration: {
      baseline: { status: 'observed', runCount: 1 }, implementationStarted: true, correction: { status: 'not_run', consumed: false },
      comparisons: [{ checkId: 'B1', outcome: 'changed_to_pass', sameOutput: false }, { checkId: 'B2', outcome: 'unchanged_pass', sameOutput: true }]
    } });
    expect(task).toEqual(saved);
    expect(() => taskResultSchema.parse({ ...result, behaviorCalibration: { ...result.behaviorCalibration, comparisons: [{ checkId: 'B1', outcome: 'fixed', sameOutput: false }] } })).toThrow();
  });
  it.each(['runWorkspace', 'workspace', 'checkedAt'] as const)('leaves candidate checks and comparisons unconfirmed without %s', (field) => {
    const task = calibrated(); delete task.behavior![field];
    expect(taskResult(task)).toMatchObject({ behaviorChecks: 'unconfirmed', acceptance: 'unverified', resolutionClaimed: false, behaviorCalibration: { baseline: { status: 'observed' }, comparisons: [{ checkId: 'B1', outcome: 'unconfirmed' }, { checkId: 'B2', outcome: 'unconfirmed' }] } });
  });
  it.each(['digest', 'scope'] as const)('does not compare a candidate whose settled workspace changed %s during execution', (field) => {
    const task = calibrated(), stamp = task.behavior!.runWorkspace!;
    task.behavior!.runWorkspace = { ...stamp, ...(field === 'digest' ? { digest: 'c'.repeat(64) } : { scope: 'directory' as const }) };
    expect(taskResult(task)).toMatchObject({ behaviorChecks: 'unconfirmed', behaviorCalibration: { baseline: { status: 'observed' }, comparisons: [{ outcome: 'unconfirmed' }, { outcome: 'unconfirmed' }] } });
  });
  it.each(['running', 'unavailable'] as const)('retains a consumed %s diagnosis without claiming a valid baseline', (status) => {
    const task = calibrated(); task.behavior!.calibration!.correction = { status };
    expect(taskResult(task)).toMatchObject({ behaviorChecks: 'unconfirmed', behaviorCalibration: { baseline: { status: 'unconfirmed' }, correction: { status, consumed: true }, comparisons: [{ outcome: 'unconfirmed' }, { outcome: 'unconfirmed' }] } });
  });
  it('does not compare a baseline run against itself or invent calibration for legacy tasks', () => {
    const task = calibrated(), state = task.behavior!;
    state.runPurpose = 'baseline'; state.status = 'pending'; state.calibration!.implementationStarted = false;
    expect(taskResult(task)).toMatchObject({ behaviorChecks: 'not_run', behaviorCalibration: { implementationStarted: false, comparisons: [] } });
    delete state.calibration; state.runPurpose = 'candidate'; state.status = 'passed';
    expect(taskResult(task).behaviorCalibration).toBeUndefined();
    expect(taskResult(task).behaviorChecks).toBe('passed');
    expect(taskResult(implemented()).behaviorCalibration).toBeUndefined();
  });
  it('does not accept a cached observed baseline when its digest or candidate receipts are invalid', () => {
    const task = calibrated(), state = task.behavior!;
    delete state.calibration!.runs[0]!.before.digest;
    expect(taskResult(task)).toMatchObject({ behaviorChecks: 'unconfirmed', behaviorCalibration: { baseline: { status: 'unconfirmed' }, comparisons: [{ outcome: 'unconfirmed' }, { outcome: 'unconfirmed' }] } });
    const candidate = calibrated(); candidate.behavior!.receipts[0]!.tool = 'powershell';
    expect(taskResult(candidate).behaviorCalibration!.comparisons[0]!.outcome).toBe('unconfirmed');
  });
});

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
