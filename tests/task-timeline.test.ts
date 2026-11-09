import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createExecutionState, type TaskState } from '../src/task/controller.js';
import { executionTimeline, type TimelineEntry } from '../src/task/timeline.js';

const snapshot = (task: TaskState): TimelineEntry => ({ type: 'custom', customType: 'pforge.task', data: structuredClone(task) });
const call = (id: string, time = 1000): TimelineEntry => ({ type: 'message', id, message: { role: 'assistant', timestamp: time, stopReason: 'toolUse', usage: { totalTokens: 25 }, content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'toolCall', id: 'same-tool-id', name: 'read', arguments: { path: 'PRIVATE_PATH' } }] } });
const output = (time = 1050): TimelineEntry => ({ type: 'message', message: { role: 'toolResult', toolCallId: 'same-tool-id', timestamp: time, content: [{ type: 'text', text: 'PRIVATE_OUTPUT' }], isError: false } });

describe('Pi-backed read-only execution projection', () => {
  it('retains each independent reviewer under its own attempt and does not attach the previous result to a running retry', () => {
    const task = createExecutionState('Fix task', { workflow: 'planned' });
    task.phase = 'review'; task.phases = [{ phase: 'review', startedAt: task.startedAt, endedAt: task.updatedAt }];
    const first = randomUUID(), second = randomUUID();
    task.reviewer = { sessionId: first, model: 'mock/reviewer', context: 'independent' };
    const entries = [snapshot(task)];
    task.phases.push({ phase: 'implement', startedAt: task.updatedAt, endedAt: task.updatedAt }, { phase: 'review', startedAt: task.updatedAt });
    task.reviewer = undefined; entries.push(snapshot(task));
    const running = executionTimeline(entries, { activeTaskId: task.id })!;
    expect(running.nodes.filter((node) => node.label === 'independent reviewer')).toMatchObject([{ parentId: task.id + ':phase:0' }]);
    task.reviewer = { sessionId: second, model: 'mock/reviewer', context: 'independent' };
    task.phases[2]!.endedAt = task.updatedAt; task.status = 'completed'; entries.push(snapshot(task));
    const restored = executionTimeline(JSON.parse(JSON.stringify(entries)))!;
    expect(restored.nodes.filter((node) => node.label === 'independent reviewer').map((node) => ({ id: node.id, parentId: node.parentId }))).toEqual([
      { id: task.id + ':reviewer:' + first, parentId: task.id + ':phase:0' },
      { id: task.id + ':reviewer:' + second, parentId: task.id + ':phase:2' }
    ]);
  });
  it('uses stable identities, actual results and token usage without exposing content or replay controls', () => {
    const task = createExecutionState('Fix project', { workflow: 'direct' });
    const entries = [snapshot(task), call('entry-1'), output()];
    task.status = 'completed'; task.phases[0]!.endedAt = task.updatedAt; entries.push(snapshot(task));
    const first = executionTimeline(entries)!;
    expect(first).toEqual(executionTimeline(JSON.parse(JSON.stringify(entries))));
    expect(first).toMatchObject({ version: 1, readOnly: true, truncated: false });
    expect(first.nodes.find((node) => node.kind === 'tool')).toMatchObject({ status: 'completed', durationMs: 50, timing: 'message_interval' });
    expect(first.nodes.find((node) => node.kind === 'model')?.tokens).toBe(25);
    expect(first.edges.filter((edge) => edge.kind === 'contains')).toHaveLength(3);
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE_|replay|arguments|thinking/);
  });
  it('does not infer a missing tool result from task completion and isolates subsequent runs', () => {
    const first = createExecutionState('Fix one', { workflow: 'direct' });
    const second = createExecutionState('Fix two', { workflow: 'direct' });
    const entries = [snapshot(first), call('one'), snapshot(second), call('two'), output()];
    const interrupted = executionTimeline(entries, { taskId: first.id })!;
    expect(interrupted.nodes[0]?.status).toBe('interrupted');
    expect(interrupted.nodes.find((node) => node.kind === 'tool')?.status).toBe('interrupted');
    const live = executionTimeline(entries, { activeTaskId: second.id })!;
    expect(live.nodes[0]?.status).toBe('running'); expect(live.nodes.find((node) => node.kind === 'tool')?.status).toBe('completed');
    expect(live.nodes.map((node) => node.id).every((id) => id.startsWith(second.id))).toBe(true);
    expect(executionTimeline(entries, { taskId: 'unknown' })).toBeUndefined();
  });
  it('preserves failed check attempts, retry edges and stale evidence as separate observations', () => {
    const task = createExecutionState('Fix task', { workflow: 'planned' });
    task.phases = [{ phase: 'verify', startedAt: task.startedAt, endedAt: task.startedAt }]; task.phase = 'verify';
    task.verification = { status: 'failed', attempts: 0, report: { passed: false, summary: 'bad', results: [{ command: 'SECRET_COMMAND', passed: false, exitCode: 1, durationMs: 8, output: 'PRIVATE_OUTPUT' }] } };
    const entries = [snapshot(task)];
    task.phases.push({ phase: 'implement', startedAt: task.startedAt, endedAt: task.startedAt }, { phase: 'verify', startedAt: task.startedAt, endedAt: task.startedAt });
    task.phase = 'verify'; task.verification = { status: 'passed', attempts: 1, evidenceId: task.id, evidence: { freshness: 'stale', configHash: 'a'.repeat(64), workspace: { version: 1, scope: 'git', files: 1, digest: 'b'.repeat(64) } }, report: { passed: true, summary: 'ok', results: [{ command: 'SECRET_COMMAND', passed: true, exitCode: 0, durationMs: 5, output: 'PRIVATE_OUTPUT' }] } };
    task.status = 'needs_attention'; entries.push(snapshot(task));
    const timeline = executionTimeline(entries)!;
    expect(timeline.nodes.filter((node) => node.kind === 'check').map((node) => node.status)).toEqual(['failed', 'completed']);
    expect(timeline.nodes.filter((node) => node.kind === 'check').at(-1)?.freshness).toBe('stale');
    expect(JSON.stringify(timeline)).not.toMatch(/SECRET_COMMAND|PRIVATE_OUTPUT/);
    expect(timeline.nodes.filter((node) => node.kind === 'phase')[0]?.status).toBe('failed');
  });
  it('marks retry edges for repeated implementation and bounds long histories explicitly', () => {
    const task = createExecutionState('Fix task', { workflow: 'planned' });
    task.phases = ['implement', 'verify', 'review', 'implement'].map((phase) => ({ phase: phase as 'implement' | 'verify' | 'review', startedAt: task.startedAt }));
    const entries = [snapshot(task), ...Array.from({ length: 1700 }, (_, index) => ({ type: 'message', id: String(index), message: { role: 'assistant', content: [], timestamp: 1000 } }))];
    const result = executionTimeline(entries)!;
    expect(result.edges.some((edge) => edge.kind === 'retry')).toBe(true); expect(result.truncated).toBe(true); expect(result.nodes).toHaveLength(1600);
    expect(result.edges.every((edge) => result.nodes.some((node) => node.id === edge.from) && result.nodes.some((node) => node.id === edge.to))).toBe(true);
  });
});
