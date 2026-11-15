import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { beginBehaviorRun, behaviorHash, newBehaviorState, settleBehaviorRun, type BehaviorPlan, type BehaviorReceipt, type BehaviorState } from '../src/task/behavior.js';
import { reviewBoundaryEvidence, reuseNativeCommandEvidence } from '../src/task/review-boundary-evidence.js';
import type { ReviewCommandEvidence } from '../src/task/review-evidence.js';
const request = 'Fix mixed case and preserve blank input';
const plan: BehaviorPlan = { version: 1, status: 'ready', summary: 'Controlled evidence fixture', assumptions: [], unresolved: [], checks: [
  { id: 'B1', kind: 'reproduction', requestQuote: 'Fix mixed case', expectation: 'Mixed case normalizes', command: 'node repro.cjs', shell: 'bash', timeoutSeconds: 30 },
  { id: 'B2', kind: 'boundary', requestQuote: 'preserve blank input', expectation: 'Blank input remains accepted', command: 'node boundary.cjs', shell: 'bash', timeoutSeconds: 30 }
] };
const stamp = (value: string) => ({ version: 1 as const, scope: 'git' as const, digest: value.repeat(64), files: 1 });
function receipts(state: BehaviorState, codes: number[]): BehaviorReceipt[] {
  return codes.map((code, index) => { const check = state.plan!.checks[index]!, output = code ? 'native assertion failed' : 'native assertion passed';
    return { version: 1, runId: state.runId!, checkId: check.id, toolCallId: randomUUID(), tool: check.shell, commandSha256: behaviorHash(check.command), source: 'pi-builtin-shell', exitCode: code, status: code ? 'failed' : 'passed', output, outputSha256: behaviorHash(output), outputCharacters: output.length, truncated: false, recordedAt: new Date().toISOString() }; });
}
function fixture() {
  let state = beginBehaviorRun({ ...newBehaviorState(request), plan }, stamp('a'), 'baseline');
  state.receipts = receipts(state, [1, 0]); state = settleBehaviorRun(state, stamp('a'));
  state.calibration!.implementationStarted = true; state = beginBehaviorRun(state, stamp('b'), 'candidate');
  state.receipts = receipts(state, [0, 1]); return settleBehaviorRun(state, stamp('b'));
}
describe('paired native review evidence', () => {
  it('pairs the same commands and original-request anchors without trusting cached comparisons', () => {
    const state = fixture(), saved = structuredClone(state);
    state.calibration!.comparisons = [];
    const evidence = reviewBoundaryEvidence(state, request)!;
    expect(evidence.pairs[0]).toMatchObject({ kind: 'reproduction', observation: 'changed_to_pass', attributable: true, baseline: { exitCode: 1 }, candidate: { exitCode: 0 } });
    expect(evidence.pairs[1]).toMatchObject({ kind: 'boundary', originalRequestQuote: 'preserve blank input', quotePresent: true, observation: 'candidate_regression', attributable: true, baseline: { exitCode: 0 }, candidate: { exitCode: 1, source: 'pi-builtin-shell' } });
    expect(evidence.pairs.every(pair => pair.baseline!.commandSha256 === pair.candidate!.commandSha256)).toBe(true);
    expect(state.receipts).toEqual(saved.receipts);
  });
  it.each(['hash', 'truncation', 'duplicate', 'workspace', 'quote'] as const)('does not promote unusable %s evidence', kind => {
    const state = fixture(); let original = request;
    if (kind === 'hash') state.receipts[1]!.outputSha256 = 'c'.repeat(64);
    if (kind === 'truncation') state.receipts[1]!.truncated = true;
    if (kind === 'duplicate') state.receipts[0] = structuredClone(state.receipts[1]!);
    if (kind === 'workspace') delete state.runWorkspace;
    if (kind === 'quote') original = 'Different request';
    expect(reviewBoundaryEvidence(state, original)!.pairs[1]).toMatchObject({ observation: 'unconfirmed', attributable: false, sameOutput: null });
  });
  it('does not invent paired observations on legacy records', () => {
    const state = fixture(); delete state.calibration;
    expect(reviewBoundaryEvidence(state, request)).toBeUndefined();
  });
  it('reuses only exact native history copies and preserves failure counts and full receipts', () => {
    const state = fixture(), native = state.receipts[1]!;
    const bounded = (text: string) => ({ text, sha256: behaviorHash(text), characters: text.length, truncated: false });
    const commands: ReviewCommandEvidence = { version: 1, source: 'pi-selected-branch', scope: 'latest-implementation', freshness: 'historical-unattested', classification: 'heuristic-not-verification',
      commands: [{ toolCallId: native.toolCallId, tool: native.tool, command: bounded(plan.checks[1]!.command), output: bounded(native.output), toolError: true, kind: 'test', outcome: 'failed' }], omitted: 0, scanTruncated: false,
      summary: { receipts: 1, retainedReceipts: 1, testReceipts: 1, failedReceipts: 1, zeroTestReceipts: 0, sourceTruncatedReceipts: 0 } };
    const saved = structuredClone({ state, commands }), reused = reuseNativeCommandEvidence(commands, state)!;
    expect(reused.commands).toHaveLength(0); expect(reused.representedByNativeReceipts).toEqual([{ toolCallId: native.toolCallId, runId: native.runId, checkId: 'B2' }]);
    expect(reused.summary).toMatchObject({ receipts: 1, retainedReceipts: 0, failedReceipts: 1 });
    commands.commands[0]!.sourceTruncation = 'reported'; expect(reuseNativeCommandEvidence(commands, state)).toBe(commands);
    commands.commands[0]!.sourceTruncation = undefined; commands.commands[0]!.output.sha256 = 'f'.repeat(64);
    expect(reuseNativeCommandEvidence(commands, state)).toBe(commands);
    expect(state).toEqual(saved.state); expect(saved.commands.commands).toHaveLength(1);
  });
});
