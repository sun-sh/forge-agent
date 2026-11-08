import { describe, expect, it } from 'vitest';
import { TaskProgress, TaskStalledError } from '../src/task/progress.js';
import { createExecutionState, restoreTask, TaskController } from '../src/task/controller.js';

const read = (path = 'a.ts', content = 'unchanged') => ({ toolName: 'read', input: { path }, content: [{ type: 'text', text: content }], isError: false });
describe('bounded progress observations', () => {
  it('detects repeated successful shell output instead of resetting progress on every exit-zero response', () => {
    const progress = new TaskProgress();
    const bash = { toolName: 'bash', input: { command: 'echo unchanged' }, content: [{ type: 'text', text: 'unchanged\n' }], isError: false };
    for (let i = 0; i < 30; i++) progress.observe(bash);
    expect(progress.snapshot()).toMatchObject({ status: 'stalled', warnings: 1, unchanged: 12 });
    const fresh = new TaskProgress();
    for (let i = 0; i < 30; i++) fresh.observe({ ...bash, content: [{ type: 'text', text: 'new evidence ' + i }] });
    expect(fresh.snapshot().status).toBe('active');
  });
  it.each(['bash', 'powershell'])('ignores changing Pi %s duration when the command and evidence repeat', (toolName) => {
    const progress = new TaskProgress();
    for (let i = 0; i < 30; i++) {
      const event = {
        toolName, input: { command: 'echo unchanged' }, content: [{ type: 'text', text: 'unchanged\n' }], isError: false,
        structuredContent: { output: 'unchanged\n', truncated: false, exit_code: 0, wall_time_seconds: i / 10 }
      };
      progress.observe(event);
      expect(event.structuredContent.wall_time_seconds).toBe(i / 10);
    }
    expect(progress.snapshot()).toMatchObject({ status: 'stalled', warnings: 1, unchanged: 12, observations: 13 });
  });
  it.each([
    ['output', { output: 'new evidence\n' }], ['exit code', { exit_code: 1 }],
    ['truncation', { truncated: true }], ['full output location', { full_output_path: '/full-output.txt' }],
    ['additional evidence', { evidence: 'changed' }]
  ])('retains changes to shell %s as new evidence even with the same model-facing text', (_name, update) => {
    const progress = new TaskProgress();
    const event = {
      toolName: 'bash', input: { command: 'inspect' }, content: [{ type: 'text', text: 'same visible excerpt' }], isError: false,
      structuredContent: { output: 'unchanged\n', truncated: false, exit_code: 0, wall_time_seconds: 0.1 }
    };
    for (let i = 0; i < 7; i++) progress.observe(event);
    expect(progress.snapshot().status).toBe('warned');
    progress.observe({ ...event, structuredContent: { ...event.structuredContent, ...update } });
    expect(progress.snapshot()).toMatchObject({ status: 'active', unchanged: 0, warnings: 1 });
  });
  it('preserves duration fields for custom tools and non-Pi result shapes', () => {
    for (const toolName of ['custom_measurement', 'bash']) {
      const progress = new TaskProgress();
      for (let i = 0; i < 30; i++) progress.observe({
        toolName, input: {}, content: [], isError: false,
        structuredContent: { ...(toolName === 'custom_measurement' ? { output: '', truncated: false, exit_code: 0 } : {}), wall_time_seconds: i / 10 }
      });
      expect(progress.snapshot()).toMatchObject({ status: 'active', unchanged: 0, warnings: 0 });
    }
  });
  it('warns then stops unchanged reads, retains no raw tool data and resets only on a new run', () => {
    const progress = new TaskProgress(); progress.begin();
    for (let i = 0; i < 6; i++) expect(progress.observe(read('secret.env', 'private-token'))).toBeUndefined();
    expect(progress.observe(read('secret.env', 'private-token'))).toContain('change the search');
    expect(progress.snapshot()).toMatchObject({ status: 'warned', warnings: 1, unchanged: 6 });
    for (let i = 0; i < 6; i++) progress.observe(read('secret.env', 'private-token'));
    expect(() => progress.check()).toThrow(TaskStalledError);
    expect(JSON.stringify(progress.snapshot())).not.toMatch(/secret.env|private-token/);
    progress.observe(read('new.ts', 'new')); expect(() => progress.check()).toThrow(TaskStalledError);
    progress.begin(); expect(() => progress.check()).not.toThrow();
  });
  it('detects small unchanged cycles and repeated identical failures while allowing changed output and successful mutations', () => {
    const progress = new TaskProgress();
    for (let i = 0; i < 10; i++) progress.observe(read(i % 2 ? 'a.ts' : 'b.ts'));
    expect(progress.snapshot()).toMatchObject({ status: 'warned', unchanged: 8 });
    progress.observe(read('a.ts', 'new source')); expect(progress.snapshot().status).toBe('active');
    for (let i = 0; i < 5; i++) progress.observe(read('a.ts', 'new source'));
    progress.observe({ toolName: 'edit', input: {}, content: [], isError: false }); expect(progress.snapshot().unchanged).toBe(0);
    progress.begin();
    for (let i = 0; i < 7; i++) progress.observe({ toolName: 'bash', input: { command: 'npm test' }, content: [{ type: 'text', text: 'Exact failing output\n' }], isError: true });
    expect(progress.snapshot().status).toBe('warned');
    progress.observe({ toolName: 'bash', input: { command: 'npm test' }, content: [{ type: 'text', text: 'different failing output\n' }], isError: true });
    expect(progress.snapshot().unchanged).toBe(0);
  });
  it('allows genuinely new evidence and phase transitions without losing the total warning count', () => {
    const progress = new TaskProgress();
    for (let i = 0; i < 100; i++) progress.observe(read('file.ts', String(i)), 'inspect');
    expect(progress.snapshot().status).toBe('active');
    for (let i = 0; i < 7; i++) progress.observe(read(), 'inspect');
    expect(progress.snapshot().warnings).toBe(1);
    progress.observe(read(), 'plan'); expect(progress.snapshot()).toMatchObject({ status: 'active', unchanged: 0, warnings: 1 });
  });
  it('persists a stalled task as needing attention instead of successful or automatically retried', async () => {
    let saved: any; const controller = new TaskController((task) => { saved = task; });
    const progress = new TaskProgress((snapshot) => controller.recordProgress(snapshot));
    const task = await controller.run('Explain the code.', 2, {
      async execute() { for (let i = 0; i < 13; i++) progress.observe(read()); progress.check(); return ''; },
      async verify() { throw new Error('must not verify'); }, async refreshVerification() { throw new Error('must not refresh'); },
      async baseline() { return { available: false, files: [] }; }, async changes() { throw new Error('must not compare'); }
    });
    expect(task).toMatchObject({ status: 'needs_attention', repairs: 0, progress: { status: 'stalled' } });
    expect(restoreTask([{ type: 'custom', customType: 'pforge.task', data: saved }])).toMatchObject({ status: 'needs_attention', progress: { status: 'stalled' } });
    controller.setExternalState(createExecutionState('Another question', { workflow: 'direct' })); progress.begin();
    expect(controller.state?.progress?.status).toBe('active');
  });
});
