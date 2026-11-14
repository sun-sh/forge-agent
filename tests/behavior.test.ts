import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { behaviorHash, behaviorCurrent, behaviorDesignPrompt, behaviorPlanSchema, beginBehaviorRun, newBehaviorState, parseBehaviorPlan, settleBehaviorRun, type BehaviorPlan, type BehaviorReceipt } from '../src/task/behavior.js';
import { behaviorExecutionExtension } from '../src/task/behavior-runtime.js';
import { TaskController, restoreTask, taskStateSchema, type TaskAdapter } from '../src/task/controller.js';
import { taskResult } from '../src/task/result.js';
import { parseReview, reviewStop } from '../src/task/review.js';
import handoff from './fixtures/task-handoff.json' with { type: 'json' };

const request = 'Fix normalizeTag and preserve valid empty inputs. Run relevant checks.';
const workspace = { version: 1 as const, scope: 'git' as const, digest: 'a'.repeat(64), files: 2 };
const plan: BehaviorPlan = { version: 1, status: 'ready', summary: 'Exercise the requested behavior and a boundary', assumptions: [], unresolved: [], checks: [
  { id: 'B1', kind: 'reproduction', requestQuote: 'Fix normalizeTag', expectation: 'Normalize the mixed-case tag', command: 'node repro.cjs', shell: 'bash', timeoutSeconds: 60 },
  { id: 'B2', kind: 'boundary', requestQuote: 'preserve valid empty inputs', expectation: 'Empty inputs remain valid', command: 'node boundary.cjs', shell: 'bash', timeoutSeconds: 60 }
] };
const receipt = (runId: string, index: number, exitCode = 0): BehaviorReceipt => ({ version: 1, runId, checkId: plan.checks[index]!.id, toolCallId: 'call-' + index, tool: 'bash', commandSha256: behaviorHash(plan.checks[index]!.command), source: 'pi-builtin-shell', exitCode, status: exitCode ? 'failed' : 'passed', output: 'actual process output', outputSha256: behaviorHash('actual process output'), outputCharacters: 21, truncated: false, recordedAt: new Date().toISOString() });
const initial = () => beginBehaviorRun({ ...newBehaviorState(request), plan }, workspace);
function fixture(options: { skip?: boolean; fail?: boolean; badPlan?: boolean } = {}) {
  let designs = 0, checks = 0;
  const controller = new TaskController(() => {});
  const verification = { status: 'passed' as const, attempts: 0, evidenceId: randomUUID(), evidence: { workspace, configHash: 'b'.repeat(64), freshness: 'current' as const }, report: { passed: true, summary: 'Configured check passed', results: [{ command: 'node --check main.js', passed: true, exitCode: 0, durationMs: 1, output: '' }] } };
  const phases: string[] = [];
  const adapter: TaskAdapter = {
    async execute(phase) {
      phases.push(phase);
      if (phase === 'inspect') return JSON.stringify({ ...handoff.brief, steps: ['Implement the requested scope'] });
      if (phase === 'check') { checks++; if (!options.skip) plan.checks.forEach((_, index) => controller.recordBehaviorReceipt(receipt(controller.state!.behavior!.runId!, index, options.fail && index === 1 ? 1 : 0))); }
      return 'Phase complete; checks passed (prose must never be evidence)';
    },
    async behaviorPlan() { designs++; return { text: options.badPlan ? 'not JSON' : JSON.stringify(plan), sessionId: randomUUID(), model: 'mock/independent' }; },
    behaviorShell: 'bash', async behaviorWorkspace() { return workspace; },
    async verify() { return verification; }, async refreshVerification() { return verification; },
    async baseline() { return { available: true, files: [] }; }, async changes() { return { available: true, truncated: false, files: [] }; },
    async review() { return { text: JSON.stringify({ verdict: 'ready', summary: 'Static review passed', issues: [], acceptance: handoff.acceptance }), sessionId: randomUUID(), model: 'mock/reviewer' }; }
  };
  return { controller, adapter, phases, verification, designs: () => designs, checks: () => checks };
}

describe('independent behavioral evidence', () => {
  it('requires anchored quotes, distinct commands, a reproduction and a boundary', () => {
    expect(parseBehaviorPlan(JSON.stringify(plan), request, 'bash')).toEqual(plan);
    expect(parseBehaviorPlan(JSON.stringify(plan), 'unrelated request', 'bash')).toBeUndefined();
    expect(parseBehaviorPlan(JSON.stringify(plan), request, 'powershell')).toBeUndefined();
    expect(behaviorPlanSchema.safeParse({ ...plan, checks: [plan.checks[0]] }).success).toBe(false);
    expect(behaviorPlanSchema.safeParse({ ...plan, checks: [plan.checks[0], { ...plan.checks[1], command: plan.checks[0]!.command }] }).success).toBe(false);
    expect(behaviorPlanSchema.safeParse({ ...plan, checks: [{ ...plan.checks[0], command: 'cat auth.json' }, plan.checks[1]] }).success).toBe(false);
    expect(behaviorDesignPrompt(request, ['main.js'], 'bash')).not.toContain('implementationSteps');
  });
  it('never turns a skipped command, wrong command/run, or changed workspace into a pass', () => {
    const state = initial();
    expect(settleBehaviorRun(state, workspace).status).toBe('unconfirmed');
    state.receipts = [receipt(state.runId!, 0), receipt(randomUUID(), 1)];
    expect(settleBehaviorRun(state, workspace).status).toBe('unconfirmed');
    state.receipts = [receipt(state.runId!, 0), { ...receipt(state.runId!, 1), commandSha256: 'c'.repeat(64) }];
    expect(settleBehaviorRun(state, workspace).status).toBe('unconfirmed');
    state.receipts = [receipt(state.runId!, 0), receipt(state.runId!, 1)];
    const passed = settleBehaviorRun(state, workspace);
    expect(passed.status).toBe('passed'); expect(behaviorCurrent(passed, workspace.digest)).toBe(true);
    expect(behaviorCurrent(passed, 'c'.repeat(64))).toBe(false);
    expect(settleBehaviorRun(state, { ...workspace, digest: 'c'.repeat(64) }).status).toBe('unconfirmed');
  });
  it('maps missing execution to evidence recovery without inventing a code defect', () => {
    const review = parseReview(JSON.stringify({ verdict: 'changes_requested', summary: 'Required test not run', issues: ['npm test was not executed'], issueKinds: ['missing_execution'], acceptance: [{ id: 'A1', status: 'unmet', evidence: 'No tool receipt' }] }), { requireIssueKinds: true })!;
    expect(review).toMatchObject({ verdict: 'insufficient_evidence', issues: [], acceptance: [{ id: 'A1', status: 'unconfirmed' }] });
    expect(reviewStop(review, ['A1'])).toEqual({ reason: 'insufficient_evidence', action: 'provide_evidence', issueCount: 0, unconfirmedIds: ['A1'] });
    expect(parseReview(JSON.stringify({ verdict: 'changes_requested', summary: 'Unknown kind', issues: ['failure'] }), { requireIssueKinds: true })).toBeUndefined();
    expect(parseReview(JSON.stringify({ verdict: 'changes_requested', summary: 'No typed finding for unmet execution', issues: [], acceptance: [{ id: 'A1', status: 'unmet', evidence: 'Test missing' }] }), { requireIssueKinds: true })).toBeUndefined();
  });
  it('executes before review, persists the contract and binds passes to current host evidence', async () => {
    const f = fixture();
    const task = await f.controller.run(request, 0, f.adapter, undefined, undefined, { workflow: 'planned', mode: 'agent', behaviorRequired: true });
    expect(task.status).toBe('completed'); expect(task.behavior?.status).toBe('passed');
    expect(task.phases.map((item) => item.phase)).toEqual(['inspect', 'plan', 'implement', 'check', 'verify', 'review', 'complete']);
    expect(f.designs()).toBe(1); expect(taskStateSchema.safeParse(task).success).toBe(true);
    expect(taskResult(task)).toMatchObject({ status: 'implemented_unverified', behaviorChecks: 'passed', resolutionClaimed: false });
    const changed = structuredClone(task); changed.verification!.evidence!.workspace.digest = 'c'.repeat(64);
    expect(taskResult(changed)).toMatchObject({ status: 'blocked', behaviorChecks: 'unconfirmed' });
  });
  it.each([{ skip: true }, { fail: true }, { badPlan: true }])('a ready model cannot override missing/failed/invalid behavior evidence: %j', async (options) => {
    const f = fixture(options);
    const task = await f.controller.run(request, 0, f.adapter, undefined, undefined, { workflow: 'planned', mode: 'agent', behaviorRequired: true });
    expect(f.phases).toContain('implement'); // A design limitation must not silently prevent writing code.
    expect(task.status).toBe('needs_attention'); expect(task.review?.verdict).toBe('ready');
    expect(taskResult(task)).toMatchObject({ status: 'blocked', modelReview: 'insufficient_evidence', reviewStop: { action: 'provide_evidence', issueCount: 0 } });
  });
  it('does not add behavioral checks to a request classified as verification only', async () => {
    const f = fixture();
    f.adapter.execute = async () => JSON.stringify({ ...handoff.brief, intent: 'verify' });
    const task = await f.controller.run('Run project verification', 0, f.adapter, undefined, undefined, { workflow: 'planned', mode: 'agent', behaviorRequired: true });
    expect(task).toMatchObject({ kind: 'verify', status: 'completed' }); expect(task.behavior).toBeUndefined(); expect(f.designs()).toBe(0);
  });
  it('continues with the frozen plan, reruns checks, and never replays implementation', async () => {
    const f = fixture({ skip: true });
    const previous = await f.controller.run(request, 0, f.adapter, undefined, undefined, { workflow: 'planned', mode: 'agent', behaviorRequired: true });
    const oldRun = previous.behavior!.runId; f.phases.length = 0;
    f.adapter.execute = async (phase) => { f.phases.push(phase); if (phase === 'check') plan.checks.forEach((_, index) => f.controller.recordBehaviorReceipt(receipt(f.controller.state!.behavior!.runId!, index))); return 'Checked'; };
    const task = await f.controller.run(request, 0, f.adapter, previous.id, undefined, { workflow: 'planned', mode: 'agent', behaviorRequired: true, resumeState: previous });
    expect(f.phases).toEqual(['check']); expect(f.designs()).toBe(1); expect(task.status).toBe('completed');
    expect(task.behavior!.plan).toEqual(plan); expect(task.behavior!.runId).not.toBe(oldRun);
    expect(task.behavior!.receipts.every((item) => item.runId === task.behavior!.runId)).toBe(true);
    const interrupted = structuredClone(task); interrupted.status = 'running'; interrupted.behavior!.status = 'running';
    expect(restoreTask([{ type: 'custom', customType: 'pforge.task', data: interrupted }])?.behavior?.status).toBe('unconfirmed');
  });
});

describe('native Pi behavior receipt policy', () => {
  function policy() {
    const state = initial(), callbacks: Record<string, any> = {}, receipts: BehaviorReceipt[] = [];
    let trusted = true, active = true, selected = ['read', 'write', 'bash'];
    const pi: any = { on: (type: string, callback: any) => { callbacks[type] = callback; }, getActiveTools: () => selected, setActiveTools: (names: string[]) => { selected = names; }, getAllTools: () => ['read', 'write', 'bash', 'powershell', 'mcp'].map((name) => ({ name, sourceInfo: { source: name === 'mcp' ? 'extension' : 'builtin' } })) };
    behaviorExecutionExtension({ active: () => active, state: () => state, trusted: () => trusted, record: (value) => { receipts.push(value); state.receipts.push(value); } })(pi);
    return { state, callbacks, receipts, trusted: (value: boolean) => { trusted = value; }, active: (value: boolean) => { active = value; }, selected: () => selected };
  }
  it('allows only exact commands in trusted projects, clamps timeouts and prevents duplicate checks', () => {
    const p = policy(); p.callbacks['before_agent_start']({ systemPromptOptions: { sections: {} } });
    expect(p.selected()).not.toContain('write'); expect(p.selected()).not.toContain('mcp');
    expect(p.callbacks['tool_call']({ toolName: 'write', input: {} }).block).toBe(true);
    expect(p.callbacks['tool_call']({ toolName: 'bash', toolCallId: 'bad', input: { command: 'echo invented' } }).block).toBe(true);
    const call = { toolName: 'bash', toolCallId: 'real', input: { command: plan.checks[0]!.command, timeout: 999 } };
    expect(p.callbacks['tool_call'](call)).toBeUndefined(); expect(call.input.timeout).toBe(60);
    expect(p.callbacks['tool_call']({ ...call, toolCallId: 'duplicate' }).block).toBe(true);
    p.trusted(false); expect(p.callbacks['tool_call']({ toolName: 'read', input: {} }).block).toBe(true);
    p.active(false); p.callbacks['before_agent_start']({ systemPromptOptions: { sections: {} } }); expect(p.selected()).toContain('write');
  });
  it('does not attribute a result to a frozen command if another extension mutated its input', () => {
    const p = policy();
    p.callbacks['tool_call']({ toolName: 'bash', toolCallId: 'real', input: { command: plan.checks[0]!.command } });
    p.callbacks['tool_result']({ toolName: 'bash', toolCallId: 'real', input: { command: 'echo substituted' }, structuredContent: { exit_code: 0, output: 'success', truncated: false }, isError: false, content: [] });
    expect(p.receipts[0]!.status).toBe('unconfirmed');
  });
  it.each([{ structuredContent: undefined, isError: false, status: 'unconfirmed' }, { structuredContent: { exit_code: 0, output: '0 passed', truncated: false }, isError: false, status: 'unconfirmed' }, { structuredContent: { exit_code: 1, output: 'assertion failed', truncated: false }, isError: true, status: 'failed' }, { structuredContent: { exit_code: 0, output: 'assertions passed', truncated: false }, isError: false, status: 'passed' }, { structuredContent: { exit_code: 0, output: 'api_key=must-not-persist', truncated: false }, isError: false, status: 'unconfirmed' }])('records actual metadata, not success prose: $status', ({ structuredContent, isError, status }) => {
    const p = policy();
    p.callbacks['tool_call']({ toolName: 'bash', toolCallId: 'real', input: { command: plan.checks[0]!.command } });
    p.callbacks['tool_result']({ toolName: 'bash', toolCallId: 'real', input: { command: plan.checks[0]!.command }, structuredContent, isError, content: [{ type: 'text', text: 'All passed (unattested prose)' }] });
    expect(p.receipts).toHaveLength(1); expect(p.receipts[0]!.status).toBe(status);
    expect(JSON.stringify(p.receipts)).not.toContain('must-not-persist');
  });
});
