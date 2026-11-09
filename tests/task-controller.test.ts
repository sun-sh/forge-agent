import { describe, expect, it, vi } from 'vitest';
import { TaskController, restoreTask, taskPhaseContract, withTaskEvidence, type TaskAdapter, type TaskState } from '../src/task/controller.js';
import { taskKind } from '../src/task/intent.js';
import type { PforgeVerificationOutcome } from '../src/verification/pi-extension.js';
import { VerificationInterruptedError } from '../src/verification/verify.js';
import { randomUUID } from 'node:crypto';
import handoff from './fixtures/task-handoff.json' with { type: 'json' };
import { ReviewEvidenceError } from '../src/task/git.js';

const evidence = { workspace: { version: 1 as const, scope: 'git' as const, digest: 'a'.repeat(64), files: 1 }, configHash: 'b'.repeat(64), freshness: 'current' as const };

function fixture(verification: PforgeVerificationOutcome = { status: 'passed', attempts: 0, evidence, evidenceId: randomUUID(), report: { passed: true, summary: 'PASS', results: [{ command: 'test', exitCode: 0, passed: true, durationMs: 1, output: 'ok' }] } }, review = '{"verdict":"ready","summary":"Reviewed","issues":[]}', briefIntent: 'answer' | 'explore' | 'change' | 'verify' | 'clarify' = 'change') {
  const reviewText = (() => { try { return JSON.stringify({ acceptance: handoff.acceptance, ...JSON.parse(review) }); } catch { return review; } })();
  const brief = { ...handoff.brief, intent: briefIntent };
  const saved: TaskState[] = [], phases: string[] = [], messages: string[] = [];
  const controller = new TaskController((state) => saved.push(state));
  const adapter: TaskAdapter = {
    async execute(phase, message) { phases.push(phase); messages.push(message); return phase === 'review' ? reviewText : phase === 'plan' ? JSON.stringify(handoff.plan) : phase === 'inspect' ? JSON.stringify(brief) : phase + ' complete'; },
    async review(message, signal) { return { text: await adapter.execute('review', message, false, signal), sessionId: randomUUID(), model: 'mock/independent-reviewer' }; },
    async verify() { return verification; },
    async refreshVerification() { return verification; },
    async baseline() { return { available: true, files: [] }; },
    async changes() { return { available: true, truncated: false, files: [] }; }
  };
  return { saved, phases, messages, controller, adapter };
}

describe('task workflow controller', () => {
  it('continues from a real-provider-shaped inspection handoff with evidence prose and a single final JSON object', async () => {
    const f = fixture(), execute = f.adapter.execute;
    f.adapter.execute = async (...args) => args[0] === 'inspect' ? 'Inspection complete. Findings:\n- Relevant implementation and tests located.\n\n' + JSON.stringify(handoff.brief) : execute(...args);
    const task = await f.controller.run('请解决登录接口的 500 错误', 0, f.adapter);
    expect(task).toMatchObject({ kind: 'change', status: 'completed' });
    expect(task.phases.map((phase) => phase.phase)).toEqual(['inspect', 'plan', 'implement', 'verify', 'review', 'complete']);
  });
  it('routes an explicit host verification action without inferring intent from its descriptive text', async () => {
    const f = fixture(), prompt = '运行项目配置的验证命令，检查刚刚应用的子任务变更。';
    expect(taskKind(prompt)).toBe('verify');
    const task = await f.controller.run(prompt, 0, f.adapter, undefined, undefined, { workflow: 'planned', mode: 'agent', requestedKind: 'verify' });
    expect(task).toMatchObject({ kind: 'verify', status: 'completed' });
    expect(task.phases.map((phase) => phase.phase)).toEqual(['verify', 'complete']);
    expect(f.phases).toEqual([]);
  });
  it.each(['请解决登录接口的 500 错误', '请把登录按钮变成蓝色', 'Make the sign-in button blue', '请解决登录错误，不要修改现有测试', '请解决登录接口的 500 错误，然后运行测试', '请分析并解决登录问题', 'Inspect and fix login, do not modify tests', '查看并修复接口，不要删除数据库', 'Run tests, then fix the failing behavior', '继续'])('resolves implementation phrasing through structured inspection regardless of the hint: %s', async (prompt) => {
    const f = fixture();
    const task = await f.controller.run(prompt, 0, f.adapter, undefined, undefined, { workflow: 'planned', mode: 'agent' });
    expect(task).toMatchObject({ intentHint: expect.any(String), kind: 'change', mode: 'agent', status: 'completed' });
    expect(f.phases).toEqual(['inspect', 'plan', 'implement', 'review']); expect(task.verification?.status).toBe('passed');
  });
  it('keeps an ambiguous structured understanding pending instead of guessing', async () => {
    for (const [prompt, intent] of [['处理一下那个', 'clarify'], ['Fix login', 'change']] as const) {
      const f = fixture(); const execute = f.adapter.execute;
      f.adapter.execute = async (...args) => args[0] === 'inspect' ? JSON.stringify({ ...handoff.brief, intent, unresolved: ['Which visible result is required?'] }) : execute(...args);
      const task = await f.controller.run(prompt, 0, f.adapter);
      expect(task.status).toBe('needs_attention'); expect(f.phases).not.toContain('implement');
    }
  });
  it('coalesces usage snapshots while immediately persisting critical transitions and flushing final counts', async () => {
    vi.useFakeTimers();
    try {
      const saved: TaskState[] = [], controller = new TaskController((task) => saved.push(task));
      const f = fixture(), task = await f.controller.run('Fix task', 0, f.adapter);
      task.status = 'running'; controller.setExternalState(task); const initial = saved.length;
      for (let i = 0; i < 100; i++) controller.recordProgress({ version: 1, status: 'active', observations: i, unchanged: 0, warnings: 0 });
      expect(saved).toHaveLength(initial); expect(controller.state?.progress?.observations).toBe(99);
      await vi.advanceTimersByTimeAsync(1000); expect(saved).toHaveLength(initial + 1);
      controller.recordProgress({ version: 1, status: 'warned', observations: 101, unchanged: 6, warnings: 1 });
      expect(saved).toHaveLength(initial + 2);
      controller.recordProgress({ version: 1, status: 'warned', observations: 102, unchanged: 7, warnings: 1 });
      controller.flush(); expect(saved.at(-1)?.progress?.observations).toBe(102);
    } finally { vi.useRealTimers(); }
  });
  it('persists host-assigned acceptance IDs and passes the validated plan to implementation and review', async () => {
    const f = fixture(); const task = await f.controller.run('Fix the task without changing protected files', 0, f.adapter);
    expect(task.plan?.acceptance).toMatchObject([{ id: 'A1', criterion: handoff.plan.acceptance[0]!.criterion }]);
    expect(task.requirements).toMatchObject({ goal: handoff.brief.goal, constraints: handoff.brief.constraints, acceptance: [{ id: 'A1' }] });
    expect(f.messages[2]).toContain('MODEL-AUTHORED REFERENCE DATA'); expect(f.messages[2]).toContain('"id":"A1"');
    expect(f.messages.at(-1)).toContain('exactly one acceptance result');
    expect(restoreTask([{ type: 'custom', customType: 'pforge.task', data: task }])?.plan).toEqual(task.plan);
    expect(restoreTask([{ type: 'custom', customType: 'pforge.task', data: task }])?.requirements).toEqual(task.requirements);
    const legacy = { ...task }; delete legacy.plan; delete legacy.review!.acceptance;
    delete legacy.requirements;
    expect(restoreTask([{ type: 'custom', customType: 'pforge.task', data: legacy }])).toMatchObject({ status: 'completed', requirements: task.requirements });
  });
  it.each(['plain prose', JSON.stringify({ ...handoff.plan, trust: true }), JSON.stringify({ ...handoff.plan, acceptance: [] })])('stops malformed plan handoff before implementation: %s', async (output) => {
    const f = fixture(); const execute = f.adapter.execute; let checked = false;
    f.adapter.execute = async (...args) => args[0] === 'plan' ? output : execute(...args);
    f.adapter.verify = async () => { checked = true; throw new Error('must not run'); };
    const task = await f.controller.run('Fix the task', 2, f.adapter);
    expect(task).toMatchObject({ status: 'needs_attention', phase: 'plan', repairs: 0 });
    expect(task.phases.at(-1)?.endedAt).toBeTypeOf('string'); expect(f.saved.at(-1)).toEqual(task);
    expect(checked).toBe(false); expect(f.phases).not.toContain('implement'); expect(f.controller.active).toBe(false);
  });
  it.each([
    undefined, [], [{ id: 'A1', status: 'unconfirmed', evidence: 'No supporting evidence' }],
    [{ id: 'A2', status: 'met', evidence: 'Invented criterion' }],
    [{ id: 'A1', status: 'met', evidence: 'one' }, { id: 'A1', status: 'met', evidence: 'duplicate' }]
  ])('rejects ready reviews without exact confirmed acceptance coverage: %j', async (acceptance) => {
    const f = fixture(); const execute = f.adapter.execute;
    f.adapter.execute = async (...args) => args[0] === 'review' ? JSON.stringify({ verdict: 'ready', summary: 'Claimed done', issues: [], acceptance }) : execute(...args);
    const result = await f.controller.run('Fix the task', 0, f.adapter);
    expect(result.status).toBe('needs_attention'); expect(result.verification?.status).toBe('passed');
    expect(withTaskEvidence({ ...result, status: 'completed' }, result.verification!).status).toBe('needs_attention');
  });
  it('prioritizes implementation intent when a change also asks for verification', () => {
    expect(taskKind('修改代码并运行测试')).toBe('change');
    expect(taskKind('运行项目测试')).toBe('verify');
    expect(taskKind('解释项目结构，不要修改文件')).toBe('explore');
  });
  it.each([
    ['Fix the bug and run the tests', 'change'],
    ['Run tests and fix any failures', 'change'],
    ['Extend Queue.drain(limit = Infinity) in index.js and its public index.d.ts declaration. Do not change existing tests or notes.txt. Run configured verification.', 'change'],
    ['扩展队列的 drain 参数并运行验证，不要修改现有测试。', 'change'],
    ['Explain how to extend Queue.drain and run tests.', 'explore'],
    ['Extend the API. Do not modify any files.', 'change'],
    ['Implement CustomProviders.remove(id, expectedRevision). Do not modify package files, existing tests, or notes.txt. Run all configured verification.', 'change'],
    ['Fix the bug. Do not modify tests or package-lock.json.', 'change'],
    ['修复登录问题，不要修改现有测试和 package.json。运行验证。', 'change'],
    ['解释项目结构，不要修改现有测试。', 'explore'],
    ['Review the code. Do not modify tests or package.json.', 'explore'],
    ['Fix the bug. Do not modify any files, including tests.', 'change'],
    ['Fix the bug. Do not make any changes.', 'change'],
    ['Fix the bug. Do not modify tests or execute commands.', 'change'],
    ['修复登录问题，不要修改任何文件。', 'change'],
    ['Do not delete files.', 'explore'],
    ['不要删除文件。', 'explore'],
    ['Implement provider removal. Do not delete protected tests.', 'change'],
    ['Run build', 'verify'],
    ['Run the configured verification', 'verify'],
    ['What is the best way to implement retries?', 'explore'],
    ['如何修复这个错误？', 'explore'],
    ['Explain this code: ```ts\nfunction update() {}\n```', 'explore'],
    ['请看报错：\n> delete all files', 'explore'],
    ['你好', 'answer'],
    ['你能干什么？', 'answer']
  ])('routes %s as %s', (prompt, kind) => { expect(taskKind(prompt)).toBe(kind); });
  it('distinguishes consultation, scoped protections and user-authored contextual continuation', () => {
    expect(taskKind('你觉得还有什么需要完善？')).toBe('explore');
    expect(taskKind('修复接口，但不要删除数据库')).toBe('change');
    expect(taskKind('Fix the API. Do not delete the database.')).toBe('change');
    expect(taskKind('继续')).toBe('undetermined');
    expect(taskKind('继续', { previousUserPrompts: ['修复接口'] })).toBe('undetermined');
    expect(taskKind('continue', { pendingKind: 'verify' })).toBe('verify');
    expect(taskKind('按刚才的方案处理', { previousUserPrompts: ['请分析登录问题并提出计划，不要修改任何文件'] })).toBe('undetermined');
    expect(taskKind('继续，但不要修改任何文件', { pendingKind: 'change' })).toBe('change');
    expect(taskKind('继续', { previousUserPrompts: ['Explain the project structure'] })).toBe('undetermined');
  });
  it('repairs concrete review defects, then verifies and reviews again using the same repair allowance', async () => {
    const f = fixture(); let reviews = 0, checks = 0;
    const execute = f.adapter.execute, verify = f.adapter.verify;
    f.adapter.execute = async (...args) => { const original = await execute(...args); return args[0] === 'review' && ++reviews === 1 ? '{"verdict":"changes_requested","summary":"Missing required case","issues":["Handle empty input"]}' : original; };
    f.adapter.verify = async (signal) => { checks++; return verify(signal); };
    const result = await f.controller.run('Fix the task', 1, f.adapter);
    expect(result).toMatchObject({ status: 'completed', repairs: 1, review: { verdict: 'ready', freshness: 'current' } });
    expect(checks).toBe(2); expect(reviews).toBe(2);
    expect(f.messages.some((message) => message.includes('Handle empty input') && message.includes('share this bounded retry budget'))).toBe(true);
    expect(f.messages[0]).toBe('Fix the task'); expect(taskPhaseContract('inspect')).toContain('HOST PHASE CONTRACT'); expect(f.messages[1]).toContain('Do not restart');
  });
  it('does not reset the repair counter between verification and review failures', async () => {
    const f = fixture(undefined, '{"verdict":"changes_requested","summary":"Defect","issues":["Blocking bug"]}');
    const pass = await f.adapter.verify(new AbortController().signal); let calls = 0;
    f.adapter.verify = async () => ++calls === 1 ? { status: 'failed', attempts: 0, error: 'failure' } : pass;
    const result = await f.controller.run('Fix the task', 1, f.adapter);
    expect(result.status).toBe('needs_attention'); expect(result.repairs).toBe(1); expect(calls).toBe(2);
    expect(f.phases.filter((phase) => phase === 'implement')).toHaveLength(2);
  });
  it('persists invalidated verification and review without claiming current completion', async () => {
    const f = fixture(); const result = await f.controller.run('Fix the task', 0, f.adapter);
    const stale = withTaskEvidence(result, { ...result.verification!, evidence: { ...evidence, freshness: 'stale', reason: 'Changed after undo' } });
    expect(stale).toMatchObject({ status: 'needs_attention', review: { freshness: 'stale' }, verification: { status: 'passed', evidence: { freshness: 'stale' } } });
    expect(stale.verification?.report).toEqual(result.verification?.report);
    expect(restoreTask([{ type: 'custom', customType: 'pforge.task', data: stale }])).toEqual(stale);
  });
  it('runs implementation and verification when a change preserves only named files', async () => {
    const f = fixture();
    const result = await f.controller.run('Implement provider deletion. Do not modify package files, existing tests, or notes.txt. Run all configured verification.', 0, f.adapter);
    expect(result.kind).toBe('change'); expect(result.status).toBe('completed');
    expect(f.phases).toEqual(['inspect', 'plan', 'implement', 'review']); expect(result.verification?.status).toBe('passed');
  });
  it('does not skip implementation and review when an extension request also asks to run verification', async () => {
    const f = fixture();
    const result = await f.controller.run('Extend Queue.drain(limit = Infinity) and its public declaration. Do not change existing tests or notes.txt. Run configured verification.', 0, f.adapter);
    expect(result.kind).toBe('change'); expect(result.status).toBe('completed');
    expect(f.phases).toEqual(['inspect', 'plan', 'implement', 'review']);
  });
  it('completes only after verification and structured review pass', async () => {
    const f = fixture();
    const result = await f.controller.run('Fix the task', 1, f.adapter);
    expect(f.phases).toEqual(['inspect', 'plan', 'implement', 'review']);
    expect(result.status).toBe('completed');
    expect(result.phase).toBe('complete');
    expect(result.verification?.status).toBe('passed');
    expect(result.review?.verdict).toBe('ready');
    expect(f.saved.length).toBeGreaterThan(6);
    expect(f.controller.active).toBe(false);
  });
  it('passes the full bounded patch into the independent reviewer and never persists it on task snapshots', async () => {
    const f = fixture();
    f.adapter.reviewPatch = async () => ({ version: 1, files: [{ path: 'code.ts', status: ' M', preexisting: false, observed: true, patch: '@@ -1 +1 @@\n-old implementation\n+new implementation' }], characters: 60, lines: 3 });
    const result = await f.controller.run('Fix code', 0, f.adapter);
    expect(result.status).toBe('completed'); expect(f.messages.at(-1)).toContain('+new implementation');
    expect(JSON.stringify(f.saved)).not.toContain('+new implementation');
  });
  it('stops before review when a patch cannot be read completely', async () => {
    const f = fixture(); f.adapter.reviewPatch = async () => { throw new ReviewEvidenceError('审阅证据过大'); };
    const result = await f.controller.run('Fix code', 0, f.adapter);
    expect(result).toMatchObject({ status: 'needs_attention', error: '审阅证据过大' }); expect(f.phases).not.toContain('review');
  });
  it('refuses to certify a planned change when the independent reviewer is unavailable', async () => {
    const f = fixture(); f.adapter.review = undefined;
    const result = await f.controller.run('Fix the task', 0, f.adapter);
    expect(result).toMatchObject({ status: 'needs_attention', error: '独立审阅不可用，未将同会话自审作为完成证据。' });
    expect(result.review).toBeUndefined();
  });
  it('keeps the ending of a long original request in the reviewer handoff without slicing the JSON envelope', async () => {
    const f = fixture(); let reviewPrompt = '';
    const originalReview = f.adapter.review!;
    f.adapter.review = async (message, signal) => { reviewPrompt = message; return originalReview(message, signal); };
    const prompt = 'background '.repeat(8_000) + '\nTAIL_ACCEPTANCE: preserve auth.ts and run the configured verification';
    const result = await f.controller.run(prompt, 0, f.adapter);
    expect(result.status).toBe('completed');
    expect(reviewPrompt).toContain('TAIL_ACCEPTANCE');
    expect(reviewPrompt).toContain('"understanding"');
    expect(reviewPrompt).toContain('"sha256"');
  });
  it('persists optional review notes without treating them as unresolved defects', async () => {
    const notes = ['Optional improvement outside the requested scope.'];
    const f = fixture(undefined, JSON.stringify({ verdict: 'ready', summary: 'Acceptance criteria met', issues: [], notes }));
    const result = await f.controller.run('Fix the task', 0, f.adapter);
    expect(result.status).toBe('completed'); expect(result.review?.notes).toEqual(notes);
    expect(f.messages.at(-1)).toContain('non-empty issues always prevents completion');
    expect(restoreTask([{ type: 'custom', customType: 'pforge.task', data: result }])?.review?.notes).toEqual(notes);
  });
  it.each([
    { verdict: 'ready', summary: 'Contradiction', issues: ['Actual acceptance defect'], notes: ['Optional improvement'] },
    { verdict: 'changes_requested', summary: 'Needs changes', issues: [], notes: ['Optional improvement'] },
    { verdict: 'ready', summary: 'Invalid notes', issues: [], notes: 'unvalidated free text' }
  ])('keeps review notes from bypassing invalid verdicts, findings or schema: %j', async (review) => {
    const f = fixture(undefined, JSON.stringify(review));
    expect((await f.controller.run('Fix the task', 0, f.adapter)).status).toBe('needs_attention');
  });
  it('resolves answer and exploration prompts through structured inspection without implementation or verification', async () => {
    let baselines = 0, verifications = 0, changes = 0;
    const answerFixture = fixture(undefined, undefined, 'answer');
    answerFixture.adapter.baseline = async () => { baselines++; return { available: true, files: [] }; };
    answerFixture.adapter.verify = async () => { verifications++; return { status: 'passed', attempts: 0, report: { passed: true, summary: 'unexpected', results: [{ command: 'test', exitCode: 0, passed: true, durationMs: 1, output: '' }] } }; };
    answerFixture.adapter.changes = async () => { changes++; return { available: true, truncated: false, files: [] }; };
    const answer = await answerFixture.controller.run('What can you do?', 2, answerFixture.adapter);
    expect(answer).toMatchObject({ kind: 'answer', status: 'completed', phase: 'complete' });
    expect(answer.phases.at(-1)?.endedAt).toBeTypeOf('string');
    expect(answerFixture.saved.at(-1)).toEqual(answer);
    expect(answerFixture.phases).toEqual(['inspect', 'inspect']);
    expect(baselines).toBe(0); expect(verifications).toBe(0); expect(changes).toBe(0);
    const exploreFixture = fixture(undefined, undefined, 'explore');
    exploreFixture.adapter.baseline = answerFixture.adapter.baseline;
    exploreFixture.adapter.verify = answerFixture.adapter.verify;
    exploreFixture.adapter.changes = answerFixture.adapter.changes;
    const explore = await exploreFixture.controller.run('Explain the project structure without changing files.', 2, exploreFixture.adapter);
    expect(explore).toMatchObject({ kind: 'explore', status: 'completed', phase: 'complete' });
    expect(exploreFixture.phases).toEqual(['inspect', 'inspect']);
    expect(baselines).toBe(0); expect(verifications).toBe(0); expect(changes).toBe(0);
  });
  it('routes an explicit verification request directly to the verification gate', async () => {
    const f = fixture(); let verifications = 0;
    f.adapter.verify = async () => { verifications++; return { status: 'passed', attempts: 0, evidence, report: { passed: true, summary: 'PASS', results: [{ command: 'test', exitCode: 0, passed: true, durationMs: 1, output: 'ok' }] } }; };
    const result = await f.controller.run('Run the configured tests.', 2, f.adapter, undefined, undefined, { workflow: 'planned', mode: 'agent', requestedKind: 'verify' });
    expect(result).toMatchObject({ kind: 'verify', status: 'completed', phase: 'complete' });
    expect(f.phases).toEqual([]);
    expect(verifications).toBe(1);
    expect(f.messages).toEqual([]);
    expect(result.phases.map((phase) => phase.phase)).toEqual(['verify', 'complete']);
    expect(result.phases.at(-1)?.endedAt).toBeTypeOf('string');
  });
  it.each(['failed', 'skipped', 'unchecked'] as const)('does not claim verification success for %s evidence', async (status) => {
    const f = fixture({ status, attempts: 0 });
    const result = await f.controller.run('Run tests', 2, f.adapter, undefined, undefined, { workflow: 'planned', mode: 'agent', requestedKind: 'verify' });
    expect(result.status).toBe(status === 'failed' ? 'failed' : 'needs_attention');
    expect(result.repairs).toBe(0); expect(f.messages).toEqual([]);
  });
  it('bounds repair retries and returns exact verification output to implementation', async () => {
    const output = 'verbatim\n$output\nend';
    const f = fixture({ status: 'failed', attempts: 0, report: { passed: false, summary: 'FAIL', results: [{ command: 'test', exitCode: 4, passed: false, durationMs: 1, output }] } });
    f.adapter.changes = async () => ({ available: true, truncated: false, files: [{ path: 'code.ts', status: ' M', fingerprint: String(f.phases.filter((phase) => phase === 'implement').length), preexisting: false, observed: true }] });
    const result = await f.controller.run('Fix', 2, f.adapter);
    expect(result.status).toBe('failed');
    expect(result.repairs).toBe(2);
    expect(f.phases.filter((phase) => phase === 'implement')).toHaveLength(3);
    expect(f.messages.filter((message) => message.includes(output))).toHaveLength(2);
    expect(f.phases).not.toContain('review');
    expect(result.changes?.files).toMatchObject([{ path: 'code.ts', fingerprint: '3' }]);
  });
  it.each([
    [{ status: 'passed', attempts: 0 }, '{"verdict":"ready","summary":"Claim without report","issues":[]}'],
    [{ status: 'skipped', attempts: 0 }, '{"verdict":"ready","summary":"Reviewed","issues":[]}'],
    [{ status: 'passed', attempts: 0 }, 'looks done'],
    [{ status: 'passed', attempts: 0 }, '{"verdict":"changes_requested","summary":"Bug","issues":["Broken edge case"]}'],
    [{ status: 'passed', attempts: 0 }, '{"verdict":"ready","summary":"Bug","issues":["Contradictory finding"]}']
  ] as const)('does not claim completion with missing checks or review issues', async (verification, review) => {
    const f = fixture(verification, review);
    expect((await f.controller.run('Fix', 0, f.adapter)).status).toBe('needs_attention');
  });
  it('does not start another phase after cancellation even when Pi resolves normally', async () => {
    const f = fixture();
    f.adapter.execute = async (phase) => { f.phases.push(phase); f.controller.cancel(); return 'The model claimed done'; };
    expect((await f.controller.run('Fix', 2, f.adapter)).status).toBe('aborted');
    expect(f.phases).toEqual(['inspect']);
  });
  it('restores only the latest active branch and requires explicit restart after interruption', async () => {
    const f = fixture(); const result = await f.controller.run('Fix', 0, f.adapter);
    const restored = restoreTask([{ type: 'custom', customType: 'pforge.task', data: { ...result, status: 'running' } }]);
    expect(restored?.status).toBe('interrupted');
    const controller = new TaskController(() => {}, restored);
    expect(controller.active).toBe(false);
    expect(restoreTask([{ type: 'custom', customType: 'pforge.task', data: result }, { type: 'custom', customType: 'pforge.task', data: { cleared: true } }])).toBeUndefined();
  });
  it('fails on invalid budgets without calling the model', async () => {
    const f = fixture(); await expect(f.controller.run('Fix', -1, f.adapter)).rejects.toThrow('budget'); expect(f.phases).toEqual([]);
  });
  it('invalidates completion when the Git fingerprint changes during review', async () => {
    const f = fixture(); let calls = 0;
    f.adapter.changes = async () => ({ available: true, truncated: false, files: [{ path: 'code.ts', status: ' M', fingerprint: String(++calls), preexisting: false, observed: true }] });
    const result = await f.controller.run('Fix', 0, f.adapter);
    expect(result.status).toBe('needs_attention'); expect(result.error).toContain('证据已过期');
  });
  it('rejects contradictory timeout evidence even if exit code and claimed status say passed', async () => {
    const f = fixture({ status: 'passed', attempts: 0, report: { passed: true, summary: 'Claimed pass', results: [{ command: 'test', exitCode: 0, passed: true, durationMs: 1, output: 'partial', failure: 'timeout', error: 'Command timed out' }] } });
    const result = await f.controller.run('Fix', 0, f.adapter);
    expect(result.status).toBe('needs_attention');
    expect(restoreTask([{ type: 'custom', customType: 'pforge.task', data: result }])?.verification?.report?.results[0]?.failure).toBe('timeout');
  });
  it('does not launch repair or review after cancellation during verification', async () => {
    const f = fixture();
    f.adapter.verify = async () => { f.controller.cancel(); return { status: 'failed', attempts: 0, error: 'interrupted' }; };
    const result = await f.controller.run('Fix', 2, f.adapter);
    expect(result.status).toBe('aborted');
    expect(result.repairs).toBe(0);
    expect(f.phases).toEqual(['inspect', 'plan', 'implement']);
  });
  it('retains the partial verification report when a running command is interrupted', async () => {
    const f = fixture();
    const report = { passed: false, summary: 'FAIL: cancelled', results: [{ command: 'test', exitCode: null, passed: false, durationMs: 1, output: 'partial', failure: 'aborted' as const, error: 'Command aborted' }] };
    f.adapter.verify = async () => { f.controller.cancel(); throw new VerificationInterruptedError(report, new Error('cancel')); };
    const result = await f.controller.run('Fix', 2, f.adapter);
    expect(result.status).toBe('aborted');
    expect(result.verification?.report).toEqual(report);
    expect(result.repairs).toBe(0);
    expect(restoreTask([{ type: 'custom', customType: 'pforge.task', data: result }])?.verification?.report).toEqual(report);
  });
});
