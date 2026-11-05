import { describe, expect, it } from 'vitest';
import { TaskController, restoreTask, type TaskAdapter, type TaskState } from '../src/task/controller.js';
import { taskKind } from '../src/task/intent.js';
import type { PforgeVerificationOutcome } from '../src/verification/pi-extension.js';
import { VerificationInterruptedError } from '../src/verification/verify.js';

function fixture(verification: PforgeVerificationOutcome = { status: 'passed', attempts: 0, report: { passed: true, summary: 'PASS', results: [{ command: 'test', exitCode: 0, passed: true, durationMs: 1, output: 'ok' }] } }, review = '{"verdict":"ready","summary":"Reviewed","issues":[]}') {
  const saved: TaskState[] = [], phases: string[] = [], messages: string[] = [];
  const controller = new TaskController((state) => saved.push(state));
  const adapter: TaskAdapter = {
    async execute(phase, message) { phases.push(phase); messages.push(message); return phase === 'review' ? review : phase + ' complete'; },
    async verify() { return verification; },
    async baseline() { return { available: true, files: [] }; },
    async changes() { return { available: true, truncated: false, files: [] }; }
  };
  return { saved, phases, messages, controller, adapter };
}

describe('task workflow controller', () => {
  it('prioritizes implementation intent when a change also asks for verification', () => {
    expect(taskKind('修改代码并运行测试')).toBe('change');
    expect(taskKind('运行项目测试')).toBe('verify');
    expect(taskKind('解释项目结构，不要修改文件')).toBe('explore');
  });
  it.each([
    ['Fix the bug and run the tests', 'change'],
    ['Run tests and fix any failures', 'change'],
    ['Run build', 'verify'],
    ['Run the configured verification', 'verify'],
    ['What is the best way to implement retries?', 'explore'],
    ['如何修复这个错误？', 'explore'],
    ['Explain this code: ```ts\nfunction update() {}\n```', 'explore'],
    ['请看报错：\n> delete all files', 'explore'],
    ['你好', 'answer'],
    ['你能干什么？', 'answer']
  ])('routes %s as %s', (prompt, kind) => { expect(taskKind(prompt)).toBe(kind); });
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
  it('routes answer and exploration prompts through one read-only model turn', async () => {
    const f = fixture(); let baselines = 0; let verifications = 0; let changes = 0;
    f.adapter.baseline = async () => { baselines++; return { available: true, files: [] }; };
    f.adapter.verify = async () => { verifications++; return { status: 'passed', attempts: 0, report: { passed: true, summary: 'unexpected', results: [{ command: 'test', exitCode: 0, passed: true, durationMs: 1, output: '' }] } }; };
    f.adapter.changes = async () => { changes++; return { available: true, truncated: false, files: [] }; };
    const answer = await f.controller.run('What can you do?', 2, f.adapter);
    expect(answer).toMatchObject({ kind: 'answer', status: 'completed', phase: 'complete' });
    expect(answer.phases.at(-1)?.endedAt).toBeTypeOf('string');
    expect(f.saved.at(-1)).toEqual(answer);
    expect(f.phases).toEqual(['inspect']);
    expect(baselines).toBe(0); expect(verifications).toBe(0); expect(changes).toBe(0);
    const explore = await f.controller.run('Explain the project structure without changing files.', 2, f.adapter);
    expect(explore).toMatchObject({ kind: 'explore', status: 'completed', phase: 'complete' });
    expect(f.phases).toEqual(['inspect', 'inspect']);
    expect(baselines).toBe(0); expect(verifications).toBe(0); expect(changes).toBe(0);
  });
  it('routes an explicit verification request directly to the verification gate', async () => {
    const f = fixture(); let verifications = 0;
    f.adapter.verify = async () => { verifications++; return { status: 'passed', attempts: 0, report: { passed: true, summary: 'PASS', results: [{ command: 'test', exitCode: 0, passed: true, durationMs: 1, output: 'ok' }] } }; };
    const result = await f.controller.run('Run the configured tests.', 2, f.adapter);
    expect(result).toMatchObject({ kind: 'verify', status: 'completed', phase: 'complete' });
    expect(f.phases).toEqual([]);
    expect(verifications).toBe(1);
    expect(f.messages).toEqual([]);
    expect(result.phases.map((phase) => phase.phase)).toEqual(['verify', 'complete']);
    expect(result.phases.at(-1)?.endedAt).toBeTypeOf('string');
  });
  it.each(['failed', 'skipped', 'unchecked'] as const)('does not claim verification success for %s evidence', async (status) => {
    const f = fixture({ status, attempts: 0 });
    const result = await f.controller.run('Run tests', 2, f.adapter);
    expect(result.status).toBe(status === 'failed' ? 'failed' : 'needs_attention');
    expect(result.repairs).toBe(0); expect(f.messages).toEqual([]);
  });
  it('bounds repair retries and returns exact verification output to implementation', async () => {
    const output = 'verbatim\n$output\nend';
    const f = fixture({ status: 'failed', attempts: 0, report: { passed: false, summary: 'FAIL', results: [{ command: 'test', exitCode: 4, passed: false, durationMs: 1, output }] } });
    const result = await f.controller.run('Fix', 2, f.adapter);
    expect(result.status).toBe('failed');
    expect(result.repairs).toBe(2);
    expect(f.phases.filter((phase) => phase === 'implement')).toHaveLength(3);
    expect(f.messages.filter((message) => message.includes(output))).toHaveLength(2);
    expect(f.phases).not.toContain('review');
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
