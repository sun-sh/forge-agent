import { describe, expect, it } from 'vitest';
import { createExecutionState } from '../src/task/controller.js';
import { buildReviewHandoff } from '../src/task/review-handoff.js';
import { parseTaskBrief, planFromBrief, taskRequirements } from '../src/task/plan.js';
import handoff from './fixtures/task-handoff.json' with { type: 'json' };
import { reviewCommandEvidence } from '../src/task/review-evidence.js';
import { isVerificationUnconfigured } from '../src/verification/pi-extension.js';
import { randomUUID } from 'node:crypto';
import { behaviorHash, newBehaviorState, type BehaviorPlan } from '../src/task/behavior.js';

describe('focused independent review handoff', () => {
  it('includes the selected baseline and correction while deriving comparisons from receipts', () => {
    const task = createExecutionState('Fix trigger', { workflow: 'planned' });
    const state = newBehaviorState(task.prompt), runId = randomUUID(), baselineId = randomUUID();
    const plan: BehaviorPlan = { version: 1, status: 'ready', summary: 'UNIQUE_FROZEN_PLAN', checks: [
      { id: 'B1', kind: 'reproduction', requestQuote: task.prompt, expectation: 'Trigger works', command: 'node trigger.js', shell: 'bash', timeoutSeconds: 60 },
      { id: 'B2', kind: 'boundary', requestQuote: task.prompt, expectation: 'Boundary works', command: 'node boundary.js', shell: 'bash', timeoutSeconds: 60 }
    ], assumptions: [], unresolved: [] };
    const stamp = { version: 1 as const, scope: 'git' as const, files: 1, digest: 'b'.repeat(64) };
    const receipts = (id: string, failure: boolean) => plan.checks.map((check, index) => {
      const failed = failure && index === 0, output = failed ? 'BASELINE_NATIVE_FAILURE' : 'CANDIDATE_NATIVE_OUTPUT';
      return { version: 1 as const, runId: id, checkId: check.id, toolCallId: randomUUID(), tool: check.shell, commandSha256: behaviorHash(check.command), source: 'pi-builtin-shell' as const, exitCode: failed ? 1 : 0, status: failed ? 'failed' as const : 'passed' as const, output, outputSha256: behaviorHash(output), outputCharacters: output.length, truncated: false, recordedAt: task.updatedAt };
    });
    state.plan = plan; state.runId = runId; state.runPurpose = 'candidate'; state.receipts = receipts(runId, false);
    state.runWorkspace = structuredClone(stamp); state.workspace = structuredClone(stamp); state.checkedAt = task.updatedAt; state.status = 'passed';
    state.calibration = { version: 1, status: 'observed', implementationStarted: true, runs: [{ runId: baselineId, plan, status: 'observed', before: stamp, after: stamp, receipts: receipts(baselineId, true) }], comparisons: [{ checkId: 'B1', outcome: 'pre_existing_failure', sameOutput: true }], correction: { status: 'kept', result: { version: 1, action: 'keep', summary: 'Preserve the frozen checks', findings: plan.checks.map(check => ({ id: check.id, kind: check.id === 'B1' ? 'expected_failure' : 'valid_check', reason: 'Original contract retained', requestQuote: task.prompt })) } } };
    task.behavior = state; const saved = structuredClone(state);
    const result = buildReviewHandoff(task, { version: 1, files: [], characters: 0, lines: 0 });
    const evidence = JSON.parse(result.prompt.split('\n\nEVIDENCE:\n')[1]!.split('\n')[0]!).independentBehaviorChecks;
    expect(evidence).toMatchObject({ runPurpose: 'candidate', baseline: { runId: baselineId, receipts: [{ output: 'BASELINE_NATIVE_FAILURE' }, { exitCode: 0 }] }, correction: { status: 'kept', result: { action: 'keep' } }, calibration: { implementationStarted: true, correction: { consumed: true }, comparisons: [{ checkId: 'B1', outcome: 'changed_to_pass', sameOutput: false }, { checkId: 'B2', outcome: 'unchanged_pass' }] } });
    expect(result.prompt.match(/UNIQUE_FROZEN_PLAN/g)).toHaveLength(1);
    expect(task.behavior).toEqual(saved);
    delete state.runWorkspace;
    const unstamped = buildReviewHandoff(task, { version: 1, files: [], characters: 0, lines: 0 });
    const unstampedChecks = JSON.parse(unstamped.prompt.split('\n\nEVIDENCE:\n')[1]!.split('\n')[0]!).independentBehaviorChecks;
    expect(unstampedChecks.calibration).toMatchObject({ baseline: { status: 'observed' }, comparisons: [{ checkId: 'B1', outcome: 'unconfirmed' }, { checkId: 'B2', outcome: 'unconfirmed' }] });
    delete state.calibration;
    const legacy = buildReviewHandoff(task, { version: 1, files: [], characters: 0, lines: 0 });
    expect(legacy.prompt).not.toContain('BASELINE_NATIVE_FAILURE');
    expect(legacy.prompt).not.toContain('implementationStarted');
  });
  it('keeps a single complete requirement ledger and the actual patch', () => {
    const task = createExecutionState('background '.repeat(3000) + 'TAIL_REQUIREMENT', { workflow: 'planned' });
    task.brief = parseTaskBrief(JSON.stringify({ ...handoff.brief, constraints: ['UNIQUE_CONSTRAINT'], steps: ['Implement the requested behavior'] }))!;
    task.requirements = taskRequirements(task.brief); task.plan = planFromBrief(task.brief, task.requirements);
    const patch = { version: 1 as const, files: [{ path: 'src/main.ts', status: ' M', preexisting: false, observed: true, patch: '@@ -1 +1 @@\n-old\n+new' }], characters: 25, lines: 3 };
    const result = buildReviewHandoff(task, patch);
    expect(result.prompt).toContain('TAIL_REQUIREMENT'); expect(result.prompt).toContain('+new');
    expect(result.prompt.match(/UNIQUE_CONSTRAINT/g)).toHaveLength(1);
    expect(result.prompt).toContain('"id":"A1"'); expect(result.prompt).toContain('"sha256"');
    expect(result.prompt).not.toContain('"understanding"');
    expect(result).toMatchObject({ version: 2, scope: 'initial', characters: result.prompt.length });
  });
  it('labels command receipts as historical and the ledger as model-authored without changing acceptance', () => {
    const task = createExecutionState('Preserve Nx1 input behavior', { workflow: 'planned' });
    const commands = reviewCommandEvidence([], task.id, new Set(['bash']));
    const handoff = buildReviewHandoff(task, { version: 1, files: [], characters: 0, lines: 0 }, undefined, commands);
    expect(handoff.prompt).toContain('historical-unattested');
    expect(handoff.prompt).toContain('model-authored interpretations');
    expect(handoff.prompt).toContain('not the implementation transcript or a current-workspace attestation');
    expect(handoff.prompt).toContain('Missing a direct reproduction receipt is an evidence limitation, not by itself a blocking defect');
    expect(handoff.prompt).toContain('original user explicitly required that exact check');
    expect(handoff.prompt).toContain('Preserve Nx1 input behavior');
    expect(handoff.prompt).toContain('If evidence is insufficient use unconfirmed');
    expect(handoff.prompt).toContain('"insufficient_evidence"');
    expect(handoff.prompt).toContain('ORIGINAL-REQUEST COUNTEREXAMPLE CHECK');
    expect(handoff.prompt).toContain('explicit keyword overrides');
    expect(handoff.prompt).toContain('Preserve previously supported input shapes');
  });
  it('keeps invalid combined steps out of plans and preserves legacy briefs', () => {
    const brief = parseTaskBrief(JSON.stringify(handoff.brief))!;
    expect(brief).toBeDefined(); expect(planFromBrief(brief)).toBeUndefined();
    expect(parseTaskBrief(JSON.stringify({ ...handoff.brief, steps: [] }))).toBeUndefined();
    expect(planFromBrief({ ...brief, steps: ['scoped implementation'], unresolved: ['A real user decision is missing'] })).toBeUndefined();
  });
  it('only identifies a clean missing-check outcome, never protection or stale failures', () => {
    const skipped = { status: 'skipped' as const, attempts: 0, reason: 'No verification commands configured.' };
    expect(isVerificationUnconfigured(skipped)).toBe(true);
    expect(isVerificationUnconfigured({ ...skipped, reason: 'No verification commands configured. Tool failed.' })).toBe(false);
    expect(isVerificationUnconfigured({ ...skipped, error: 'storage failed' })).toBe(false);
    expect(isVerificationUnconfigured({ ...skipped, evidence: { workspace: { version: 1, scope: 'directory', files: 0 }, configHash: 'a'.repeat(64), freshness: 'stale' } })).toBe(false);
  });
});
