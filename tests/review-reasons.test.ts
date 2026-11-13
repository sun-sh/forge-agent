import { describe, expect, it } from 'vitest';
import { parseReview, reviewStop, reviewStopSchema } from '../src/task/review.js';
import { createExecutionState, restoreTask, type TaskState } from '../src/task/controller.js';
import { publicTask, taskResultSchema } from '../src/task/result.js';
// @ts-expect-error Browser-native module is exercised by JS UI tests without TS declarations.
import { reviewStopView, sessionOutcome } from '../src/web/ui/render.js';

const candidate = (verdict: string, issues: string[], status: string) => JSON.stringify({ verdict, summary: 'Review evidence', issues, acceptance: [{ id: 'A1', status, evidence: 'src/main.ts: observed trigger' }] });
describe('structured review reasons across schema, persistence, API and UI', () => {
  it('recovers a budget reason only from a matching current-task child snapshot', () => {
    const task = createExecutionState('Fix code', { workflow: 'planned' }); task.phase = 'review'; task.status = 'needs_attention';
    const child = (startedAt: string) => ({ type: 'custom', customType: 'forge.subagent', data: { purpose: 'review_gate', startedAt, budget: { status: 'exceeded' } } });
    const saved = { type: 'custom', customType: 'pforge.task', data: task };
    expect(restoreTask([saved, child(task.startedAt)])?.reviewStop).toMatchObject({ reason: 'budget_exhausted', action: 'adjust_budget', budgetScope: 'reviewer' });
    expect(restoreTask([saved, child('2000-01-01T00:00:00.000Z')])?.reviewStop).toBeUndefined();
  });
  it('accepts insufficient evidence separately and maps legacy evidence-only reviews conservatively', () => {
    const next = parseReview(candidate('insufficient_evidence', [], 'unconfirmed'))!;
    expect(next.verdict).toBe('insufficient_evidence');
    expect(parseReview(candidate('changes_requested', [], 'unconfirmed'))).toEqual(next);
    expect(reviewStop(next, ['A1'])).toEqual({ reason: 'insufficient_evidence', action: 'provide_evidence', issueCount: 0, unconfirmedIds: ['A1'] });
    expect(parseReview(candidate('insufficient_evidence', ['a real defect'], 'unmet'))).toBeUndefined();
    expect(reviewStop(parseReview(candidate('changes_requested', ['src/main.ts: broken edge'], 'unmet'))!, ['A1'])).toMatchObject({ reason: 'code_defects', action: 'fix_code', issueCount: 1 });
  });
  it.each([
    [{ reason: 'budget_exhausted', action: 'adjust_budget', issueCount: 0, unconfirmedIds: [], budgetScope: 'reviewer' }, '审阅未完成', '执行预算', 'budget_exhausted'],
    [{ reason: 'insufficient_evidence', action: 'provide_evidence', issueCount: 0, unconfirmedIds: ['A1'] }, '需求未验收', '人工验收', 'insufficient_evidence'],
    [{ reason: 'code_defects', action: 'fix_code', issueCount: 2, unconfirmedIds: [] }, '审阅发现 2 个问题', '修复代码', 'changes_requested']
  ] as const)('roundtrips reason %j without error-text guessing', (stop, label, action, modelReview) => {
    const task: TaskState = { ...createExecutionState('Fix code', { workflow: 'planned', mode: 'agent' }), kind: 'change', status: 'needs_attention', phase: 'review', reviewStop: reviewStopSchema.parse(stop), error: 'same generic error' };
    const restored = restoreTask([{ type: 'custom', customType: 'pforge.task', data: JSON.parse(JSON.stringify(task)) }])!;
    expect(restored.reviewStop).toEqual(stop);
    const api = publicTask(restored);
    expect(api.result.reviewStop).toEqual(stop); expect(api.result.modelReview).toBe(modelReview);
    expect(taskResultSchema.parse(api.result)).toEqual(api.result);
    expect(sessionOutcome({ task: api }).label).toContain(label);
    expect(reviewStopView(api)?.detail).toContain(action);
  });
  it('restores a legacy unconfirmed review as evidence insufficiency without inventing defects', () => {
    const task = createExecutionState('Fix code', { workflow: 'planned' }); task.phase = 'review'; task.status = 'needs_attention';
    task.review = JSON.parse(candidate('changes_requested', [], 'unconfirmed'));
    const restored = restoreTask([{ type: 'custom', customType: 'pforge.task', data: task }])!;
    expect(restored.review?.verdict).toBe('insufficient_evidence');
    expect(publicTask(restored).result.reviewStop?.reason).toBe('insufficient_evidence');
    expect(sessionOutcome({ task: restored }).label).toContain('证据不足');
  });
  it('does not accept unknown reasons or interpret malformed coverage as a code defect', () => {
    expect(reviewStopSchema.safeParse({ reason: 'future', action: 'fix_code', issueCount: 0, unconfirmedIds: [] }).success).toBe(false);
    expect(reviewStopSchema.safeParse({ reason: 'insufficient_evidence', action: 'fix_code', issueCount: 1, unconfirmedIds: ['A1'] }).success).toBe(false);
    const review = parseReview(candidate('ready', [], 'met'))!;
    review.acceptance!.push(review.acceptance![0]!);
    expect(reviewStop(review, ['A1'])?.reason).toBe('invalid_review');
  });
});
