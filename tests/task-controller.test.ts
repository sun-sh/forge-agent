import { describe, expect, it } from 'vitest';
import { TaskController, restoreTask, type TaskAdapter, type TaskState } from '../src/task/controller.js';
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
