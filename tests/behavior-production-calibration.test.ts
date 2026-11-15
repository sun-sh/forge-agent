import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { baselineNeedsDiagnosis, behaviorBaselineCurrent, behaviorCurrent, behaviorHash, behaviorNeedsEvidence, behaviorReceiptSchema, behaviorStateSchema, beginBehaviorRun, compareBehaviorBaseline, newBehaviorState, settleBehaviorRun, type BehaviorCorrection, type BehaviorPlan, type BehaviorReceipt, type BehaviorState } from '../src/task/behavior.js';
import { parseBehaviorCorrection, validateBehaviorCorrection } from '../src/task/behavior-correction.js';
import { restoreTask, TaskController, taskStateSchema, type TaskAdapter, type TaskState } from '../src/task/controller.js';
import type { WorkspaceStamp } from '../src/verification/evidence.js';
import { respondBehaviorFixture } from '../scripts/test-behavior-protocol.mjs';
import handoff from './fixtures/task-handoff.json' with { type: 'json' };

// Scripted receipts exercise production policy, not model judgment or quality.
const request = 'Fix normalizeTag and preserve valid empty inputs. Run relevant checks.';
const before: WorkspaceStamp = { version: 1, scope: 'git', digest: 'a'.repeat(64), files: 2 };
const candidate: WorkspaceStamp = { ...before, digest: 'b'.repeat(64) };
const plan: BehaviorPlan = { version: 1, status: 'ready', summary: 'Check normalization and the valid empty-input boundary', assumptions: [], unresolved: [], checks: [
  { id: 'B1', kind: 'reproduction', requestQuote: 'Fix normalizeTag', expectation: 'Normalize mixed-case input', command: 'node repro.cjs', shell: 'bash', timeoutSeconds: 60 },
  { id: 'B2', kind: 'boundary', requestQuote: 'preserve valid empty inputs', expectation: 'The public entry point accepts empty input', command: 'node boundary.cjs', shell: 'bash', timeoutSeconds: 30 }
] };
const temporary: string[] = [];
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });
async function project() { const root = await mkdtemp(join(tmpdir(), 'forge-production-calibration-')); temporary.push(root); return root; }
function receipt(state: BehaviorState, index: number, exitCode: number): BehaviorReceipt {
  const check = state.plan!.checks[index]!, output = check.id + (exitCode === 0 ? ': assertions passed' : ': assertion failed');
  return { version: 1, runId: state.runId!, checkId: check.id, toolCallId: randomUUID(), tool: check.shell, commandSha256: behaviorHash(check.command), source: 'pi-builtin-shell', exitCode, status: exitCode === 0 ? 'passed' : 'failed', output, outputSha256: behaviorHash(output), outputCharacters: output.length, truncated: false, recordedAt: new Date().toISOString() };
}
function observed(exits = [1, 0]): BehaviorState {
  const state = beginBehaviorRun({ ...newBehaviorState(request), plan: structuredClone(plan) }, before, 'baseline');
  state.receipts = exits.map((code, index) => receipt(state, index, code));
  return settleBehaviorRun(state, before);
}
function checked(state: BehaviorState, exits = [0, 0]): BehaviorState {
  state.calibration!.implementationStarted = true;
  const next = beginBehaviorRun(state, candidate, 'candidate');
  next.receipts = exits.map((code, index) => receipt(next, index, code));
  return settleBehaviorRun(next, candidate);
}
const contractLines = ['  if (value.length === 0) return value;', '  return value.toLowerCase();'];
function diagnosis(action: 'keep' | 'replace' = 'keep'): BehaviorCorrection {
  const value: BehaviorCorrection = { version: 1, action, summary: 'Retain the requested reproduction and diagnose the boundary', findings: [
    { id: 'B1', kind: 'expected_failure', reason: 'The reproduction should fail before implementation', requestQuote: plan.checks[0]!.requestQuote },
    { id: 'B2', kind: action === 'replace' ? 'invalid_expectation' : 'unconfirmed', reason: 'Check the exact owning public API contract', requestQuote: plan.checks[1]!.requestQuote }
  ] };
  if (action === 'replace') {
    value.plan = structuredClone(plan);
    value.plan.checks[1]!.command = 'node boundary-public-api.cjs';
    value.plan.checks[1]!.expectation = 'Exercise empty input through the documented public API';
    value.findings[1]!.contract = { path: 'contract.ts', quote: contractLines.join(String.fromCharCode(10)).trim() };
  }
  return value;
}
const source = ['export function normalizeTag(value: string) {', ...contractLines, '}', ''].join(String.fromCharCode(13, 10));
const signal = () => new AbortController().signal;

describe('production baseline admission and comparison', () => {
  it('retains an observed failing reproduction, then accepts the same frozen candidate checks', () => {
    const state = observed(), original = structuredClone(state.calibration!.runs);
    expect(state).toMatchObject({ status: 'pending', runPurpose: 'baseline', calibration: { status: 'observed', implementationStarted: false } });
    expect(state.calibration!.runs[0]).toMatchObject({ status: 'observed', before, after: before, receipts: [{ status: 'failed', exitCode: 1 }, { status: 'passed', exitCode: 0 }] });
    expect(baselineNeedsDiagnosis(state)).toBe(false);
    expect(behaviorBaselineCurrent(state)).toBe(true);
    expect(behaviorCurrent(state, before.digest)).toBe(false);
    const result = checked(state);
    expect(result.status).toBe('passed');
    expect(behaviorCurrent(result, candidate.digest)).toBe(true);
    expect(result.calibration!.runs).toEqual(original);
    expect(compareBehaviorBaseline(result)).toEqual([
      { checkId: 'B1', outcome: 'changed_to_pass', sameOutput: false },
      { checkId: 'B2', outcome: 'unchanged_pass', sameOutput: true }
    ]);
  });

  const invalid: Array<{ name: string; mutate(state: BehaviorState): void }> = [
    { name: 'absent baseline', mutate: state => { state.calibration!.runs = []; } },
    { name: 'partial baseline', mutate: state => { state.calibration!.runs[0]!.receipts.pop(); } },
    { name: 'missing before and after digest', mutate: state => { delete state.calibration!.runs[0]!.before.digest; delete state.calibration!.runs[0]!.after!.digest; } },
    { name: 'missing after stamp', mutate: state => { delete state.calibration!.runs[0]!.after; } },
    { name: 'changed workspace', mutate: state => { state.calibration!.runs[0]!.after!.digest = candidate.digest; } },
    { name: 'changed workspace scope', mutate: state => { state.calibration!.runs[0]!.after!.scope = 'directory'; } },
    { name: 'unconfirmed baseline relabeled globally as observed', mutate: state => { state.calibration!.runs[0]!.status = 'unconfirmed'; } },
    { name: 'receipt from another run', mutate: state => { state.calibration!.runs[0]!.receipts[0]!.runId = randomUUID(); } },
    { name: 'receipt for another command', mutate: state => { state.calibration!.runs[0]!.receipts[0]!.commandSha256 = 'c'.repeat(64); } },
    { name: 'receipt from another shell', mutate: state => { state.calibration!.runs[0]!.receipts[0]!.tool = 'powershell'; } },
    { name: 'duplicate receipt replacing a missing check', mutate: state => { state.calibration!.runs[0]!.receipts[1] = structuredClone(state.calibration!.runs[0]!.receipts[0]!); } },
    { name: 'forged failed receipt with zero exit', mutate: state => { state.calibration!.runs[0]!.receipts[0]!.exitCode = 0; } },
    { name: 'forged failed receipt without a native exit', mutate: state => { state.calibration!.runs[0]!.receipts[0]!.exitCode = null; } },
    { name: 'truncated receipt', mutate: state => { state.calibration!.runs[0]!.receipts[0]!.truncated = true; } },
    { name: 'mismatched frozen plan', mutate: state => { state.calibration!.runs[0]!.plan.checks[0]!.command = 'node different-repro.cjs'; } },
    { name: 'diagnosis still running', mutate: state => { state.calibration!.correction = { status: 'running' }; } },
    { name: 'diagnosis unavailable', mutate: state => { state.calibration!.correction = { status: 'unavailable', error: 'Source contract unresolved' }; } },
    { name: 'kept plan with unresolved diagnosis', mutate: state => { state.calibration!.correction = { status: 'kept', result: diagnosis() }; } }
  ];
  it.each(invalid)('fails closed for $name despite complete passing candidate receipts', ({ mutate }) => {
    const state = observed(); mutate(state);
    expect(behaviorBaselineCurrent(state)).toBe(false);
    const result = checked(state);
    expect(result.status).toBe('unconfirmed');
    expect(behaviorCurrent(result, candidate.digest)).toBe(false);
    expect(compareBehaviorBaseline(result).map(row => row.outcome)).toEqual(['unconfirmed', 'unconfirmed']);
  });

  it.each([null, 0])('rejects persisted failed receipts without a native nonzero exit: %s', exitCode => {
    const state = observed(), forged = { ...state.calibration!.runs[0]!.receipts[0]!, exitCode };
    expect(behaviorReceiptSchema.safeParse(forged).success).toBe(false);
    state.calibration!.runs[0]!.receipts[0] = forged;
    expect(behaviorStateSchema.safeParse(state).success).toBe(false);
  });

  it.each(['wrong shell', 'duplicate check', 'wrong run', 'wrong command', 'forged exit', 'truncated'] as const)('does not compare an invalid candidate receipt: %s', kind => {
    const state = checked(observed());
    if (kind === 'wrong shell') state.receipts[1]!.tool = 'powershell';
    if (kind === 'duplicate check') state.receipts.push(structuredClone(state.receipts[1]!));
    if (kind === 'wrong run') state.receipts[1]!.runId = randomUUID();
    if (kind === 'wrong command') state.receipts[1]!.commandSha256 = 'c'.repeat(64);
    if (kind === 'forged exit') state.receipts[1]!.exitCode = 1;
    if (kind === 'truncated') state.receipts[1]!.truncated = true;
    expect(compareBehaviorBaseline(state)[1]!.outcome).toBe('unconfirmed');
    expect(behaviorCurrent(state, candidate.digest)).toBe(false);
  });

  it('requires evidence for an inherited boundary failure without relabeling it as a candidate defect', () => {
    const state = observed([1, 1]);
    expect(baselineNeedsDiagnosis(state)).toBe(true);
    const result = checked(state, [0, 1]);
    expect(compareBehaviorBaseline(result)[1]).toEqual({ checkId: 'B2', outcome: 'pre_existing_failure', sameOutput: true });
    expect(behaviorNeedsEvidence(result)).toBe(true);
    expect(compareBehaviorBaseline(checked(observed([0, 0]), [0, 1]))[1]!.outcome).toBe('candidate_regression');
    expect(behaviorNeedsEvidence(checked(observed(), [1, 0]))).toBe(false);
  });

  it('cannot rebuild a baseline after implementation starts', () => {
    const state = checked(observed()), original = structuredClone(state);
    expect(() => beginBehaviorRun(state, candidate, 'baseline')).toThrow(/baseline/);
    expect(state).toEqual(original);
  });

  it('keeps a valid passing boundary confirmed and rejects valid_check without an observed native pass', () => {
    const state = observed(), correction = diagnosis();
    correction.findings[1]!.kind = 'valid_check';
    correction.findings[1]!.reason = 'The existing public API boundary passes with a native zero exit';
    expect(parseBehaviorCorrection(JSON.stringify(correction))).toEqual(correction);
    state.calibration!.correction = { status: 'kept', result: correction };
    expect(behaviorBaselineCurrent(state)).toBe(true);
    expect(behaviorCurrent(checked(structuredClone(state)), candidate.digest)).toBe(true);
    const failure = structuredClone(state);
    failure.calibration!.runs[0]!.receipts[1]!.status = 'failed';
    failure.calibration!.runs[0]!.receipts[1]!.exitCode = 1;
    expect(behaviorBaselineCurrent(failure)).toBe(false);
    const missing = structuredClone(state); missing.calibration!.runs[0]!.receipts.pop();
    expect(behaviorBaselineCurrent(missing)).toBe(false);
  });
});

describe('candidate workspace comparison integrity', () => {
  it.each([
    { name: 'passing receipts with a changed digest', exits: [0, 0], after: { ...candidate, digest: 'c'.repeat(64) } },
    { name: 'failed receipts with a changed digest', exits: [1, 1], after: { ...candidate, digest: 'c'.repeat(64) } },
    { name: 'passing receipts with a changed scope', exits: [0, 0], after: { ...candidate, scope: 'directory' as const } },
    { name: 'failed receipts with a changed scope', exits: [1, 1], after: { ...candidate, scope: 'directory' as const } }
  ])('leaves every comparison unconfirmed for $name during execution', ({ exits, after }) => {
    const baseline = observed(); baseline.calibration!.implementationStarted = true;
    const state = beginBehaviorRun(baseline, candidate, 'candidate');
    state.receipts = exits.map((exit, index) => receipt(state, index, exit));
    const result = settleBehaviorRun(state, after);
    expect(behaviorBaselineCurrent(result)).toBe(true);
    expect(result.runWorkspace).toEqual(candidate);
    expect(result.workspace).toEqual(after);
    expect(result.checkedAt).toEqual(expect.any(String));
    expect(result.status).not.toBe('passed');
    expect(result.calibration!.comparisons.map(row => row.outcome)).toEqual(['unconfirmed', 'unconfirmed']);
    expect(compareBehaviorBaseline(result).map(row => row.outcome)).toEqual(['unconfirmed', 'unconfirmed']);
    expect(behaviorCurrent(result, after.digest)).toBe(false);
    result.status = 'passed';
    expect(behaviorCurrent(result, after.digest)).toBe(false);
    expect(compareBehaviorBaseline(result).map(row => row.outcome)).toEqual(['unconfirmed', 'unconfirmed']);
  });

  const invalid: Array<{ name: string; mutate(state: BehaviorState): void }> = [
    { name: 'missing prerun stamp', mutate: state => { delete state.runWorkspace; } },
    { name: 'missing prerun digest', mutate: state => { delete state.runWorkspace!.digest; } },
    { name: 'mismatched prerun digest', mutate: state => { state.runWorkspace!.digest = 'c'.repeat(64); } },
    { name: 'mismatched prerun scope', mutate: state => { state.runWorkspace!.scope = 'directory'; } },
    { name: 'missing settled stamp', mutate: state => { delete state.workspace; } },
    { name: 'both digests absent', mutate: state => { delete state.runWorkspace!.digest; delete state.workspace!.digest; } },
    { name: 'missing settlement timestamp', mutate: state => { delete state.checkedAt; } }
  ];
  it.each(invalid)('cannot promote a saved modern run with $name by forcing passed status', ({ mutate }) => {
    const original = checked(observed());
    const saved = behaviorStateSchema.parse(JSON.parse(JSON.stringify(original)));
    mutate(saved); saved.status = 'passed';
    const restored = behaviorStateSchema.parse(JSON.parse(JSON.stringify(saved)));
    expect(restored.receipts.every(item => item.status === 'passed' && item.exitCode === 0)).toBe(true);
    expect(restored.calibration!.comparisons.map(row => row.outcome)).toEqual(['changed_to_pass', 'unchanged_pass']);
    expect(behaviorCurrent(restored, candidate.digest)).toBe(false);
    expect(compareBehaviorBaseline(restored).map(row => row.outcome)).toEqual(['unconfirmed', 'unconfirmed']);
  });

  it.each([
    { name: 'reproduction changes to pass', baseline: [1, 0], exits: [0, 0], outcomes: ['changed_to_pass', 'unchanged_pass'] },
    { name: 'reproduction remains a failure', baseline: [1, 0], exits: [1, 0], outcomes: ['pre_existing_failure', 'unchanged_pass'] },
    { name: 'candidate introduces a boundary regression', baseline: [0, 0], exits: [0, 1], outcomes: ['unchanged_pass', 'candidate_regression'] }
  ])('keeps same-workspace outcomes when $name', ({ baseline, exits, outcomes }) => {
    const state = checked(observed(baseline), exits);
    expect(state.runWorkspace).toEqual(candidate);
    expect(state.workspace).toEqual(candidate);
    expect(state.checkedAt).toEqual(expect.any(String));
    expect(compareBehaviorBaseline(state).map(row => row.outcome)).toEqual(outcomes);
    expect(state.calibration!.comparisons).toEqual(compareBehaviorBaseline(state));
    expect(behaviorCurrent(state, candidate.digest)).toBe(exits.every(exit => exit === 0));
    const saved = behaviorStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(compareBehaviorBaseline(saved)).toEqual(state.calibration!.comparisons);
    expect(behaviorCurrent(saved, candidate.digest)).toBe(exits.every(exit => exit === 0));
  });
});

describe('source-backed production check correction', () => {
  it('retains frozen coverage and records exact source and normalized quotation hashes', async () => {
    const root = await project(); await writeFile(join(root, 'contract.ts'), source);
    const value = diagnosis('replace'), old = structuredClone(plan);
    expect(parseBehaviorCorrection(JSON.stringify(value))).toEqual(value);
    await expect(validateBehaviorCorrection(root, plan, value, request, signal())).resolves.toEqual([{
      checkId: 'B2', path: 'contract.ts', sha256: behaviorHash(source), quoteSha256: behaviorHash(value.findings[1]!.contract!.quote)
    }]);
    expect(plan).toEqual(old);
    expect(await readFile(join(root, 'contract.ts'), 'utf8')).toBe(source);
    value.plan!.checks[1]!.timeoutSeconds = 10;
    await expect(validateBehaviorCorrection(root, plan, value, request, signal())).resolves.toHaveLength(1);
  });

  const mutations: Array<{ name: string; mutate(value: BehaviorCorrection): void }> = [
    { name: 'check count', mutate: value => { value.plan!.checks.pop(); } },
    { name: 'check IDs', mutate: value => { value.plan!.checks[1]!.id = 'B3'; } },
    { name: 'check kinds', mutate: value => { value.plan!.checks[1]!.kind = 'regression'; } },
    { name: 'shell permissions', mutate: value => { value.plan!.checks[1]!.shell = 'powershell'; } },
    { name: 'original request quote', mutate: value => { value.plan!.checks[1]!.requestQuote = 'empty inputs'; } },
    { name: 'timeout upper bound', mutate: value => { value.plan!.checks[1]!.timeoutSeconds++; } },
    { name: 'finding count', mutate: value => { value.findings.pop(); } },
    { name: 'finding IDs', mutate: value => { value.findings[1]!.id = 'B1'; } },
    { name: 'finding request anchor', mutate: value => { value.findings[1]!.requestQuote = 'empty inputs'; } },
    { name: 'source-backed diagnosis', mutate: value => { delete value.findings[1]!.contract; } },
    { name: 'supported finding kind', mutate: value => { value.findings[1]!.kind = 'expected_failure'; } },
    { name: 'exact source quotation', mutate: value => { value.findings[1]!.contract!.quote = 'A plausible contract that is absent from source'; } }
  ];
  it.each(mutations)('rejects a replacement that changes or omits $name', async ({ mutate }) => {
    const root = await project(); await writeFile(join(root, 'contract.ts'), source);
    const value = diagnosis('replace'); mutate(value);
    await expect(validateBehaviorCorrection(root, plan, value, request, signal())).rejects.toThrow();
  });

  it.each(['command', 'expectation'] as const)('requires source evidence even when only the %s changes', async field => {
    const root = await project(), value = diagnosis('replace');
    value.plan!.checks[1] = { ...plan.checks[1]!, [field]: value.plan!.checks[1]![field] };
    delete value.findings[1]!.contract;
    await expect(validateBehaviorCorrection(root, plan, value, request, signal())).rejects.toThrow(/source-backed/);
  });

  it.each(['../contract.ts', 'fixtures/../contract.ts', '.env', '.git/config', 'auth.json', 'absent.ts'])('rejects unsafe or missing contract source: %s', async path => {
    const root = await project(), value = diagnosis('replace');
    value.findings[1]!.contract!.path = path;
    await expect(validateBehaviorCorrection(root, plan, value, request, signal())).rejects.toThrow();
  });

  it('refuses absolute paths, directories, oversized files and hard-linked source evidence', async () => {
    const root = await project(), value = diagnosis('replace');
    await writeFile(join(root, 'contract.ts'), source);
    value.findings[1]!.contract!.path = join(root, 'contract.ts');
    await expect(validateBehaviorCorrection(root, plan, value, request, signal())).rejects.toThrow();
    await mkdir(join(root, 'directory')); value.findings[1]!.contract!.path = 'directory';
    await expect(validateBehaviorCorrection(root, plan, value, request, signal())).rejects.toThrow();
    await writeFile(join(root, 'large.ts'), source + 'x'.repeat(1_000_001)); value.findings[1]!.contract!.path = 'large.ts';
    await expect(validateBehaviorCorrection(root, plan, value, request, signal())).rejects.toThrow(/bounded/);
    await link(join(root, 'contract.ts'), join(root, 'linked.ts')); value.findings[1]!.contract!.path = 'linked.ts';
    await expect(validateBehaviorCorrection(root, plan, value, request, signal())).rejects.toThrow();
  });

  it('does not accept a no-op replacement or restart an aborted validation', async () => {
    const root = await project(), value = diagnosis('replace'); value.plan = structuredClone(plan);
    await expect(validateBehaviorCorrection(root, plan, value, request, signal())).rejects.toThrow(/no justified/);
    const cancellation = new AbortController(); cancellation.abort(new Error('Cancelled source validation'));
    await expect(validateBehaviorCorrection(root, plan, diagnosis('replace'), request, cancellation.signal)).rejects.toThrow('Cancelled source validation');
    const keep = diagnosis();
    await expect(validateBehaviorCorrection(root, plan, keep, request, signal())).resolves.toEqual([]);
    expect(parseBehaviorCorrection(JSON.stringify({ ...keep, plan }))).toBeUndefined();
    expect(parseBehaviorCorrection(JSON.stringify({ ...diagnosis('replace'), plan: undefined }))).toBeUndefined();
  });
});

function controllerFixture(options: { baseline?: number[]; replacementBaseline?: number[]; candidate?: number[]; skipCandidate?: boolean; correction?: BehaviorCorrection; root?: string; frozenPlan?: BehaviorPlan } = {}) {
  let workspace = before;
  const saved: TaskState[] = [], phases: string[] = [];
  const controller = new TaskController(state => { saved.push(structuredClone(state)); });
  const verification = () => ({ status: 'passed' as const, attempts: 0, evidenceId: randomUUID(), evidence: { workspace: structuredClone(workspace), configHash: 'd'.repeat(64), freshness: 'current' as const }, report: { passed: true, summary: 'Scripted configured verification', results: [{ command: 'node --check main.js', passed: true, exitCode: 0, durationMs: 1, output: '' }] } });
  const adapter = {
    execute: vi.fn<TaskAdapter['execute']>(async phase => {
      phases.push(phase);
      if (phase === 'inspect') return JSON.stringify({ ...handoff.brief, steps: ['Implement only the original requested scope'] });
      if (phase === 'implement') workspace = candidate;
      if (phase === 'check') {
        const state = controller.state!.behavior!;
        if (state.runPurpose === 'baseline' || !options.skipCandidate) {
          const baselineExits = state.calibration!.runs.length > 1 ? options.replacementBaseline ?? options.baseline : options.baseline;
          const exits = state.runPurpose === 'baseline' ? baselineExits ?? [1, 0] : options.candidate ?? [0, 0];
          exits.forEach((exit, index) => controller.recordBehaviorReceipt(receipt(state, index, exit)));
        }
      }
      return 'Scripted phase completed; prose is not execution evidence';
    }),
    behaviorShell: 'bash' as const,
    behaviorPlan: vi.fn(async () => ({ text: JSON.stringify(options.frozenPlan ?? plan), sessionId: randomUUID(), model: 'mock/designer' })),
    behaviorCorrection: vi.fn(async () => ({ text: JSON.stringify(options.correction ?? diagnosis()), sessionId: randomUUID(), model: 'mock/diagnostician' })),
    behaviorCorrectionEvidence: vi.fn<NonNullable<TaskAdapter['behaviorCorrectionEvidence']>>(async (old, correction, prompt, abort) => validateBehaviorCorrection(options.root ?? process.cwd(), old, correction, prompt, abort)),
    behaviorWorkspace: vi.fn(async () => structuredClone(workspace)),
    verify: vi.fn(async () => verification()), refreshVerification: vi.fn(async () => verification()),
    baseline: vi.fn(async () => ({ available: true, files: [] })), changes: vi.fn(async () => ({ available: true, truncated: false, files: [] })),
    review: vi.fn(async () => ({ text: JSON.stringify({ verdict: 'ready', summary: 'Scripted static review', issues: [], acceptance: handoff.acceptance }), sessionId: randomUUID(), model: 'mock/reviewer' }))
  } satisfies TaskAdapter;
  const run = (previous?: TaskState, reviewRequired = true) => controller.run(request, 2, adapter, previous?.id, undefined, { workflow: 'planned', mode: 'agent', behaviorRequired: true, reviewRequired, ...(previous ? { resumeState: previous } : {}) });
  return { controller, adapter, phases, saved, run, setWorkspace: (value: WorkspaceStamp) => { workspace = value; } };
}
function restored(state: TaskState): TaskState {
  return restoreTask([{ type: 'custom', customType: 'pforge.task', data: JSON.parse(JSON.stringify(state)) }])!;
}

describe('production calibration orchestration and persistence', () => {
  it.each(['implement', 'check', 'verify', 'review', 'complete'] as const)('never creates a preimplementation baseline when resuming legacy %s without behavior state', async phase => {
    const seed = controllerFixture(), previous = restored(await seed.run());
    delete previous.behavior; previous.status = 'interrupted'; previous.phase = phase;
    const f = controllerFixture(); f.setWorkspace(candidate);
    const task = await f.run(previous);
    expect(task.resumeOf).toBe(previous.id);
    expect(f.adapter.behaviorPlan).not.toHaveBeenCalled();
    expect(f.adapter.behaviorCorrection).not.toHaveBeenCalled();
    expect(task.phases.some(item => item.checkRole === 'baseline')).toBe(false);
    expect(f.saved.every(state => !state.behavior?.calibration || state.behavior.calibration.implementationStarted)).toBe(true);
    expect(f.saved.every(state => !state.behavior?.calibration?.runs.length)).toBe(true);
    expect(f.phases.filter(item => item === 'implement')).toHaveLength(phase === 'implement' ? 1 : 0);
  });

  it('first persists implementationStarted together with phase implement and resumes that exact save', async () => {
    const seed = controllerFixture(); await seed.run();
    const index = seed.saved.findIndex(state => state.behavior?.calibration?.implementationStarted);
    expect(index).toBeGreaterThan(0);
    const checkpoint = seed.saved[index]!;
    expect(checkpoint.phase).toBe('implement');
    expect(checkpoint.phases.at(-1)).toMatchObject({ phase: 'implement' });
    expect(checkpoint.phases.at(-1)?.checkRole).toBeUndefined();
    expect(seed.saved[index - 1]!.behavior!.calibration!.implementationStarted).toBe(false);
    expect(seed.saved.find(state => state.phase === 'implement')).toEqual(checkpoint);
    const previous = restored(checkpoint), f = controllerFixture();
    const history = structuredClone(previous.behavior!.calibration!.runs);
    const task = await f.run(previous);
    expect(task.status).toBe('completed');
    expect(f.phases).toEqual(['implement', 'check']);
    expect(task.phases.filter(item => item.phase === 'check').map(item => item.checkRole)).toEqual(['candidate']);
    expect(task.behavior!.calibration!.runs).toEqual(history);
    expect(f.adapter.behaviorPlan).not.toHaveBeenCalled();
    expect(f.adapter.behaviorCorrection).not.toHaveBeenCalled();
  });

  it.each([true, false])('continues implementation from a legacy torn baseline marker (explicit checkRole: %s)', async explicitRole => {
    const seed = controllerFixture(); await seed.run();
    const saved = seed.saved.find(state => state.behavior?.calibration?.status === 'observed' && !state.behavior.calibration.implementationStarted)!;
    const previous = restored(saved);
    expect(previous.phase).toBe('check');
    expect(previous.behavior!.runPurpose).toBe('baseline');
    previous.behavior!.calibration!.implementationStarted = true;
    if (!explicitRole) delete previous.phases.at(-1)!.checkRole;
    const history = structuredClone(previous.behavior!.calibration!.runs), f = controllerFixture();
    const task = await f.run(restored(previous));
    expect(task.status).toBe('completed');
    expect(f.phases).toEqual(['implement', 'check']);
    expect(task.phases.map(item => item.phase)).toEqual(['implement', 'check', 'verify', 'review', 'complete']);
    expect(task.phases.some(item => item.checkRole === 'baseline')).toBe(false);
    expect(task.behavior!.calibration!.runs).toEqual(history);
    expect(f.adapter.behaviorPlan).not.toHaveBeenCalled();
    expect(f.adapter.behaviorCorrection).not.toHaveBeenCalled();
  });

  it('first persists a replacement with its active plan and pending calibration, then resumes only the replacement baseline', async () => {
    const root = await project(); await writeFile(join(root, 'contract.ts'), source);
    const correction = diagnosis('replace');
    const seed = controllerFixture({ root, baseline: [1, 1], replacementBaseline: [1, 0], correction });
    await seed.run();
    const index = seed.saved.findIndex(state => state.behavior?.calibration?.correction?.status === 'replaced');
    expect(index).toBeGreaterThan(0);
    const checkpoint = seed.saved[index]!, calibration = checkpoint.behavior!.calibration!;
    expect(calibration.status).toBe('pending');
    expect(calibration.implementationStarted).toBe(false);
    expect(checkpoint.behavior!.plan).toEqual(correction.plan);
    expect(calibration.runs).toHaveLength(1);
    expect(calibration.runs[0]!.plan).toEqual(plan);
    expect(calibration.runs[0]!.receipts.map(item => item.status)).toEqual(['failed', 'failed']);
    expect(seed.saved[index - 1]!.behavior!.calibration!.correction!.status).toBe('running');
    for (const state of seed.saved.filter(item => item.behavior?.calibration?.correction?.status === 'replaced')) {
      expect(state.behavior!.plan).toEqual(correction.plan);
    }
    const previous = restored(checkpoint), f = controllerFixture({ root, baseline: [1, 0] });
    const task = await f.run(previous);
    expect(task.status).toBe('completed');
    expect(task.phases.filter(item => item.phase === 'check').map(item => item.checkRole)).toEqual(['baseline', 'candidate']);
    expect(task.behavior!.calibration!.runs).toHaveLength(2);
    expect(task.behavior!.calibration!.runs[0]).toEqual(calibration.runs[0]);
    expect(task.behavior!.calibration!.runs[1]!.plan).toEqual(correction.plan);
    expect(task.behavior!.calibration!.runs[1]!.receipts.map(item => item.status)).toEqual(['failed', 'passed']);
    expect(task.behavior!.calibration!.correction).toEqual(calibration.correction);
    expect(f.adapter.behaviorPlan).not.toHaveBeenCalled();
    expect(f.adapter.behaviorCorrection).not.toHaveBeenCalled();
    expect(f.adapter.behaviorCorrectionEvidence).not.toHaveBeenCalled();
  });

  it('runs and persists baseline checks before implementation and candidate checks before review', async () => {
    const f = controllerFixture(), task = await f.run();
    expect(task.status).toBe('completed');
    expect(task.phases.map(item => [item.phase, item.checkRole])).toEqual([['inspect', undefined], ['plan', undefined], ['check', 'baseline'], ['implement', undefined], ['check', 'candidate'], ['verify', undefined], ['review', undefined], ['complete', undefined]]);
    expect(task.behavior!.calibration!.runs[0]!.before).toEqual(before);
    expect(task.behavior!.workspace).toEqual(candidate);
    expect(task.behavior!.calibration!.comparisons.map(row => row.outcome)).toEqual(['changed_to_pass', 'unchanged_pass']);
    expect(f.adapter.behaviorPlan).toHaveBeenCalledTimes(1);
    expect(f.adapter.behaviorCorrection).not.toHaveBeenCalled();
    expect(taskStateSchema.safeParse(task).success).toBe(true);
    expect(restored(task).behavior).toEqual(task.behavior);
  });

  it('retains valid_check for an unchanged passing third check during a source-backed replacement', async () => {
    const root = await project(); await writeFile(join(root, 'contract.ts'), source);
    const frozenPlan = structuredClone(plan);
    frozenPlan.checks.push({ id: 'B3', kind: 'regression', requestQuote: 'Run relevant checks', expectation: 'Previously valid nonempty tags remain accepted', command: 'node regression.cjs', shell: 'bash', timeoutSeconds: 30 });
    const correction = diagnosis('replace');
    correction.plan!.checks.push(structuredClone(frozenPlan.checks[2]!));
    correction.findings.push({ id: 'B3', kind: 'valid_check', reason: 'The supported regression check already passes on the baseline', requestQuote: frozenPlan.checks[2]!.requestQuote });
    const f = controllerFixture({ root, frozenPlan, correction, baseline: [1, 1, 0], replacementBaseline: [1, 0, 0], candidate: [0, 0, 0] });
    const task = await f.run(), calibration = task.behavior!.calibration!;
    expect(task.status).toBe('completed');
    expect(calibration.runs[0]!.receipts[2]).toMatchObject({ checkId: 'B3', status: 'passed', exitCode: 0 });
    expect(calibration.correction!.result!.findings[2]).toMatchObject({ id: 'B3', kind: 'valid_check' });
    expect(calibration.correction!.evidence!.map(item => item.checkId)).toEqual(['B2']);
    expect(calibration.runs.every(run => run.plan.checks[2]!.command === frozenPlan.checks[2]!.command)).toBe(true);
    expect(calibration.comparisons[2]!.outcome).toBe('unchanged_pass');
    expect(behaviorCurrent(task.behavior, candidate.digest)).toBe(true);
    expect(restored(task).behavior!.calibration!.correction).toEqual(calibration.correction);
    expect(f.adapter.behaviorCorrection).toHaveBeenCalledTimes(1);
  });

  it('preserves an accepted replacement when its baseline is interrupted and resumes without another diagnosis', async () => {
    const root = await project(); await writeFile(join(root, 'contract.ts'), source);
    const correction = diagnosis('replace'), seed = controllerFixture({ root, baseline: [1, 1], correction });
    const execute = seed.adapter.execute.getMockImplementation()!;
    seed.adapter.execute.mockImplementation(async (...args) => {
      const state = seed.controller.state!.behavior;
      if (args[0] === 'check' && state?.runPurpose === 'baseline' && state.calibration!.runs.length === 2) {
        seed.controller.recordBehaviorReceipt(receipt(state, 0, 1));
        seed.controller.cancel('Interrupt replacement baseline for recovery regression');
        throw new Error('Replacement baseline interrupted after one native receipt');
      }
      return execute(...args);
    });
    const interrupted = await seed.run(), calibration = interrupted.behavior!.calibration!;
    expect(interrupted.status).toBe('aborted');
    expect(calibration).toMatchObject({ status: 'unavailable', implementationStarted: false, correction: { status: 'replaced', result: correction } });
    expect(interrupted.behavior!.plan).toEqual(correction.plan);
    expect(calibration.runs).toHaveLength(2);
    expect(calibration.runs[1]).toMatchObject({ status: 'unconfirmed', plan: correction.plan, receipts: [{ checkId: 'B1', status: 'failed', exitCode: 1 }] });
    expect(calibration.runs[1]!.receipts).toHaveLength(1);
    const accepted = seed.saved.filter(state => state.behavior?.calibration?.correction?.result?.action === 'replace');
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.every(state => state.behavior!.calibration!.correction!.status === 'replaced')).toBe(true);
    const previous = restored(interrupted), f = controllerFixture({ root, baseline: [1, 0] });
    const history = structuredClone(previous.behavior!.calibration!.runs);
    const task = await f.run(previous);
    expect(task.status).toBe('completed');
    expect(task.phases.filter(item => item.phase === 'check').map(item => item.checkRole)).toEqual(['baseline', 'candidate']);
    expect(task.behavior!.calibration!.runs).toHaveLength(3);
    expect(task.behavior!.calibration!.runs.slice(0, 2)).toEqual(history);
    expect(task.behavior!.calibration!.runs[2]).toMatchObject({ status: 'observed', plan: correction.plan });
    expect(task.behavior!.calibration!.correction).toEqual(calibration.correction);
    expect(seed.adapter.behaviorCorrection).toHaveBeenCalledTimes(1);
    expect(f.adapter.behaviorPlan).not.toHaveBeenCalled();
    expect(f.adapter.behaviorCorrection).not.toHaveBeenCalled();
    expect(f.adapter.behaviorCorrectionEvidence).not.toHaveBeenCalled();
  });

  it('retains the original plan and failures and reruns a source-backed replacement before implementation', async () => {
    const root = await project(); await writeFile(join(root, 'contract.ts'), source);
    const correction = diagnosis('replace'), f = controllerFixture({ root, baseline: [1, 1], replacementBaseline: [1, 0], correction });
    const task = await f.run(), calibration = task.behavior!.calibration!;
    expect(task.status).toBe('completed');
    expect(task.phases.filter(item => item.phase === 'check').map(item => item.checkRole)).toEqual(['baseline', 'baseline', 'candidate']);
    expect(calibration.runs).toHaveLength(2);
    expect(calibration.runs[0]!.plan).toEqual(plan);
    expect(calibration.runs[0]!.receipts.map(item => item.status)).toEqual(['failed', 'failed']);
    expect(calibration.runs[1]!.plan).toEqual(correction.plan);
    expect(calibration.runs[1]!.receipts.map(item => item.status)).toEqual(['failed', 'passed']);
    expect(calibration.correction).toMatchObject({ status: 'replaced', result: correction, evidence: [{ checkId: 'B2', path: 'contract.ts' }] });
    expect(f.adapter.behaviorCorrection).toHaveBeenCalledTimes(1);
    expect(f.adapter.behaviorCorrectionEvidence).toHaveBeenCalledTimes(1);
    expect(task.phases.map(item => item.phase)).toEqual(['inspect', 'plan', 'check', 'check', 'implement', 'check', 'verify', 'review', 'complete']);
  });

  it('requests evidence for an inherited boundary failure instead of spending repair retries on a claimed defect', async () => {
    const f = controllerFixture({ baseline: [1, 1], candidate: [0, 1] });
    f.adapter.review.mockResolvedValue({ text: JSON.stringify({ verdict: 'changes_requested', summary: 'Boundary failed', issues: ['Boundary failure alone is not a new implementation defect'], issueKinds: ['code_defect'], acceptance: handoff.acceptance.map(item => ({ ...item, status: 'unmet' })) }), sessionId: randomUUID(), model: 'mock/reviewer' });
    const task = await f.run();
    expect(task).toMatchObject({ status: 'needs_attention', repairs: 0, reviewStop: { reason: 'insufficient_evidence', action: 'provide_evidence', issueCount: 0 } });
    // An unresolved diagnosis blocks calibrated comparisons; retain both native failures.
    expect(task.behavior!.calibration!.comparisons[1]!.outcome).toBe('unconfirmed');
    expect(task.behavior!.calibration!.runs[0]!.receipts[1]!.status).toBe('failed');
    expect(task.behavior!.receipts[1]!.status).toBe('failed');
    expect(f.phases.filter(phase => phase === 'implement')).toHaveLength(1);
    expect(f.adapter.behaviorCorrection).toHaveBeenCalledTimes(1);
  });

  it('persists an interrupted diagnosis as consumed and does not open another diagnosis on resume', async () => {
    const f = controllerFixture({ baseline: [1, 1] }); await f.run();
    const checkpoint = f.saved.find(state => state.behavior?.calibration?.correction?.status === 'running')!;
    expect(checkpoint).toBeDefined();
    const previous = restored(checkpoint);
    expect(previous).toMatchObject({ status: 'interrupted', behavior: { calibration: { implementationStarted: false, correction: { status: 'unavailable' } } } });
    f.setWorkspace(before); f.phases.length = 0;
    const task = await f.run(previous);
    expect(task.status).toBe('needs_attention');
    expect(task.behavior!.calibration!.correction!.status).toBe('unavailable');
    expect(task.behavior!.calibration!.runs).toEqual(previous.behavior!.calibration!.runs);
    expect(task.phases.filter(item => item.checkRole === 'baseline')).toHaveLength(0);
    expect(f.adapter.behaviorCorrection).toHaveBeenCalledTimes(1);
    expect(f.adapter.behaviorPlan).toHaveBeenCalledTimes(1);
  });

  it('refuses stale observed baseline reuse before implementation on resume', async () => {
    const f = controllerFixture(); await f.run();
    const checkpoint = f.saved.find(state => state.behavior?.calibration?.status === 'observed' && !state.behavior.calibration.implementationStarted)!;
    const previous = restored(checkpoint);
    f.setWorkspace(candidate); f.phases.length = 0;
    const task = await f.run(previous);
    expect(task.status).toBe('needs_attention');
    expect(f.phases).toEqual([]);
    expect(task.behavior!.calibration!.runs).toEqual(previous.behavior!.calibration!.runs);
    expect(task.behavior!.calibration!.implementationStarted).toBe(false);
    expect(f.adapter.behaviorCorrection).not.toHaveBeenCalled();
  });

  it.each(['missing baseline', 'missing plan', 'unavailable plan'] as const)('never redesigns or rebuilds after implementation when resuming with %s', async limitation => {
    const f = controllerFixture(), previous = restored(await f.run());
    previous.status = 'interrupted'; previous.phase = 'verify';
    if (limitation === 'missing baseline') { previous.behavior!.calibration!.runs = []; previous.behavior!.calibration!.status = 'unavailable'; }
    if (limitation === 'missing plan') delete previous.behavior!.plan;
    if (limitation === 'unavailable plan') previous.behavior!.plan = { version: 1, status: 'unavailable', summary: 'The frozen plan cannot execute', checks: [], assumptions: [], unresolved: ['No supported runtime'] };
    const history = structuredClone(previous.behavior!.calibration!.runs); f.phases.length = 0;
    const task = await f.run(previous);
    expect(task.status).toBe('needs_attention');
    expect(f.adapter.behaviorPlan).toHaveBeenCalledTimes(1);
    expect(f.adapter.behaviorCorrection).not.toHaveBeenCalled();
    expect(f.phases).not.toContain('implement');
    expect(task.phases.filter(item => item.checkRole === 'baseline')).toHaveLength(0);
    expect(task.behavior!.calibration!.runs).toEqual(history);
  });

  it.each([{ name: 'complete native evidence', skipCandidate: false, candidate: [0, 0], expected: 'completed' }, { name: 'missing candidate receipts', skipCandidate: true, candidate: [0, 0], expected: 'needs_attention' }, { name: 'failed candidate receipt', skipCandidate: false, candidate: [1, 0], expected: 'needs_attention' }])('keeps the behavior gate when review is disabled: $name', async ({ expected, ...options }) => {
    const f = controllerFixture(options), task = await f.run(undefined, false);
    expect(task.status).toBe(expected);
    expect(f.adapter.review).not.toHaveBeenCalled();
    expect(task.phases.some(item => item.phase === 'complete')).toBe(expected === 'completed');
    expect(behaviorCurrent(task.behavior, candidate.digest)).toBe(expected === 'completed');
  });
});

describe('behavior protocol skip fixture', () => {
  it.each(['baseline', 'candidate'] as const)('skips only candidate receipts, preserving %s fixture semantics', target => {
    const chunks: string[] = [];
    const response = { writeHead: () => {}, write: (chunk: string) => { chunks.push(chunk); }, end: (chunk: string) => { chunks.push(chunk); } } as unknown as Parameters<typeof respondBehaviorFixture>[1];
    expect(respondBehaviorFixture({ messages: [{ role: 'developer', content: 'PFORGE TASK PHASE: check' }, { role: 'user', content: 'PFORGE TASK PHASE: check' + String.fromCharCode(10) + JSON.stringify({ runId: randomUUID(), target, plan }) }] }, response, { skip: true })).toBe(true);
    const delta = JSON.parse(chunks[0]!.slice('data: '.length)).choices[0].delta;
    if (target === 'baseline') expect(JSON.parse(delta.tool_calls[0].function.arguments).command).toBe(plan.checks[0]!.command);
    else expect(delta.tool_calls).toBeUndefined();
  });
});
