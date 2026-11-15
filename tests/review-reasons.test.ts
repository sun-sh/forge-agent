import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeReview, parseReview, persistedReviewSchema, reviewSchema, reviewStop, reviewStopSchema, type TaskReview } from '../src/task/review.js';
import { createExecutionState, restoreTask, taskStateSchema, type TaskState } from '../src/task/controller.js';
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

describe('typed missing-execution recovery', () => {
  const source = (issueKinds: NonNullable<TaskReview['issueKinds']> = ['missing_execution']): TaskReview => ({
    verdict: 'changes_requested', summary: 'Review evidence', issues: issueKinds.map((kind) => 'Finding: ' + kind), issueKinds,
    acceptance: [{ id: 'A1', status: 'unmet', evidence: 'Observed evidence' }]
  });
  const executionStop = { reason: 'missing_execution', action: 'run_required_tests', issueCount: 0, unconfirmedIds: ['A1'] };
  const saved = (review: TaskReview) => ({ ...createExecutionState('Run required tests', { workflow: 'planned' }), status: 'needs_attention', phase: 'review', review, reviewFollowup: review });
  const restore = (data: unknown) => restoreTask([{ type: 'custom', customType: 'pforge.task', data: JSON.parse(JSON.stringify(data)) }]);

  it('preserves the typed source finding through normalization without changing its input', () => {
    const raw = source(), before = structuredClone(raw);
    const review = parseReview(JSON.stringify(raw), { requireIssueKinds: true })!;
    expect(review).toMatchObject({ verdict: 'insufficient_evidence', issues: [], issueKinds: [], notes: raw.issues, evidenceIssues: [{ kind: 'missing_execution', text: raw.issues[0] }], acceptance: [{ id: 'A1', status: 'unconfirmed' }] });
    expect(normalizeReview(review)).toEqual(review);
    expect(raw).toEqual(before);
    expect(reviewStop(raw, ['A1'])).toEqual(executionStop);
    expect(reviewStop(review, ['A1'])).toEqual(executionStop);
    expect(reviewStopSchema.parse(executionStop)).toEqual(executionStop);
    expect(parseReview(JSON.stringify(review))).toBeUndefined(); // Host provenance is not model input.
  });

  it.each(['raw', 'normalized'] as const)('retains %s provenance across task persistence, follow-up restore and the public stop surface', (form) => {
    const review = form === 'raw' ? source() : normalizeReview(source());
    const task = saved(review), restored = restore(task)!;
    expect(taskStateSchema.safeParse(task).success).toBe(true);
    expect(restored.review?.evidenceIssues).toEqual([{ kind: 'missing_execution', text: review.issues[0] ?? review.evidenceIssues![0]!.text }]);
    expect(restored.reviewFollowup).toEqual(restored.review);
    expect(restored.reviewStop).toEqual(executionStop);
    expect(restore(restored)?.review).toEqual(restored.review);
    const api = publicTask(restored);
    expect(api.result.reviewStop).toEqual(executionStop);
    expect(api.result).toMatchObject({ status: 'blocked', resolutionClaimed: false, acceptance: 'unverified' });
    expect(taskResultSchema.safeParse(api.result).success).toBe(true);
    expect(reviewStopView(api)).toMatchObject({ action: 'run_required_tests', kind: 'unverified' });
    expect(sessionOutcome({ task: api }).label).toContain('必需测试未执行');
  });

  it('roundtrips an explicit missing-execution stop without adding provenance to a legacy review', () => {
    const legacy = JSON.parse(candidate('changes_requested', [], 'unconfirmed'));
    const restored = restore({ ...saved(legacy), reviewStop: executionStop })!;
    expect(restored.reviewStop).toEqual(executionStop);
    expect(restored.review?.issueKinds).toBeUndefined();
    expect(restored.review?.evidenceIssues).toBeUndefined();
  });

  it('renders raw and normalized execution findings consistently without guessing from prose', () => {
    const raw = source(), normalized = normalizeReview(raw);
    for (const review of [raw, normalized]) expect(reviewStopView({ review })).toMatchObject({ label: '需求未验收 · 必需测试未执行', kind: 'unverified', action: 'run_required_tests' });
    expect(reviewStopView({ review: source(['missing_execution', 'code_defect']) })).toMatchObject({ label: '审阅发现 1 个问题', action: 'fix_code' });
    const legacy = { ...raw, issueKinds: undefined, summary: 'npm test was not run; no code defect' };
    expect(reviewStopView({ review: legacy })).toMatchObject({ action: 'fix_code' });
    expect(reviewStopView({ review: { ...legacy, verdict: 'insufficient_evidence', issues: [], acceptance: [{ id: 'A1', status: 'unconfirmed', evidence: 'npm test was not run' }] } })).toMatchObject({ action: 'provide_evidence' });
    for (const acceptance of [
      [{ id: 'wrong', status: 'unmet' }],
      [{ id: 'A1', status: 'unmet' }, { id: 'A1', status: 'unmet' }],
      [{ id: 'A2', status: 'unmet' }]
    ]) expect(reviewStopView({ review: { ...raw, acceptance }, plan: { acceptance: [{ id: 'A1' }] } })).toMatchObject({ action: 'retry_review' });
    expect(reviewStopView({ review: { ...raw, issueKinds: [] } })).toMatchObject({ action: 'retry_review' });
    expect(reviewStopView({ result: { reviewStop: { ...executionStop, unconfirmedIds: [] } }, reviewStop: { reason: 'code_defects', issueCount: 9 } })).toMatchObject({ action: 'run_required_tests' });
  });

  it.each(['environment', 'requirement_ambiguity'] as const)('keeps %s as evidence recovery and retains its kind', (kind) => {
    const review = normalizeReview(source([kind]));
    expect(review.evidenceIssues).toEqual([{ kind, text: 'Finding: ' + kind }]);
    expect(reviewStop(review, ['A1'])).toEqual({ reason: 'insufficient_evidence', action: 'provide_evidence', issueCount: 0, unconfirmedIds: ['A1'] });
  });

  it.each([
    { kinds: ['missing_execution', 'code_defect'] }, { kinds: ['code_defect', 'missing_execution'] }, { kinds: ['environment', 'missing_execution', 'code_defect'] }
  ] as const)('keeps mixed concrete defects as code defects: $kinds', ({ kinds }) => {
    const raw = source([...kinds]);
    expect(normalizeReview(raw)).toEqual(raw);
    expect(reviewStop(raw, ['A1'])).toEqual({ reason: 'code_defects', action: 'fix_code', issueCount: 1, unconfirmedIds: [] });
    expect(restore(saved(raw))?.review?.issueKinds).toEqual(kinds);
  });

  it('retains every typed finding even when legacy notes already fill the notes limit', () => {
    const raw = { ...source(['environment', 'missing_execution']), notes: Array(50).fill('Existing note') };
    const review = normalizeReview(raw);
    expect(review.notes).toHaveLength(50);
    expect(review.evidenceIssues).toEqual(raw.issues.map((text, index) => ({ kind: raw.issueKinds![index], text })));
    expect(reviewStop(review, ['A1'])).toEqual(executionStop);
    expect(persistedReviewSchema.safeParse(review).success).toBe(true);
  });

  it.each(['A0', 'A13', 'A01', 'wrong'])('keeps malformed acceptance ID %s invalid before and after normalization', (id) => {
    const raw = source(); raw.acceptance![0]!.id = id;
    expect(parseReview(JSON.stringify(raw), { requireIssueKinds: true })).toBeUndefined();
    expect(reviewStop(raw, ['A1'])?.reason).toBe('invalid_review');
    expect(reviewStop(normalizeReview(raw), ['A1'])?.reason).toBe('invalid_review');
    expect(restore(saved(raw))).toBeUndefined();
    expect(reviewStop(source(), [id])?.reason).toBe('invalid_review');
  });

  it('does not let missing execution mask duplicate/unknown IDs or mismatched kind counts', () => {
    const raw = source(); raw.acceptance!.push({ ...raw.acceptance![0]! });
    expect(reviewStop(raw, ['A1'])?.reason).toBe('invalid_review');
    expect(reviewStop(source(), ['A2'])?.reason).toBe('invalid_review');
    expect(reviewStop(source(), ['A1', 'A1'])?.reason).toBe('invalid_review');
    const mismatch = { ...source(), issueKinds: [] };
    expect(reviewStop(mismatch, ['A1'])?.reason).toBe('invalid_review');
    expect(restore(saved(mismatch))).toBeUndefined();
    expect(reviewStopSchema.safeParse({ ...executionStop, action: 'fix_code' }).success).toBe(false);
    expect(reviewStopSchema.safeParse({ ...executionStop, issueCount: 1 }).success).toBe(false);
    expect(reviewStopSchema.safeParse({ ...executionStop, reason: 'code_defects' }).success).toBe(false);
  });

  it('uses the saved no-tests review conditionally on an explicit new typed annotation, leaving historical classification intact', () => {
    const report = JSON.parse(readFileSync(new URL('../docs/evaluations/review-no-tests-2026-11-13.json', import.meta.url), 'utf8'));
    const historical = reviewSchema.parse(report.result.review), snapshot = structuredClone(historical);
    const ids = historical.acceptance!.map((item) => item.id);
    expect(historical.issueKinds).toBeUndefined();
    expect(report.result.productResult.reviewStop).toMatchObject({ reason: 'code_defects', action: 'fix_code', issueCount: 1 });
    expect(reviewStop(historical, ids)?.reason).toBe('code_defects');
    const legacy = restore(saved(historical))!.review!;
    expect(legacy.issueKinds).toBeUndefined(); expect(legacy.evidenceIssues).toBeUndefined();
    // A conditional contract regression, not a new model run or a relabeled historical result.
    const annotated = { ...historical, issueKinds: historical.issues.map(() => 'missing_execution' as const) };
    const review = parseReview(JSON.stringify(annotated), { requireIssueKinds: true })!;
    expect(reviewStop(review, ids)).toEqual({ ...executionStop, unconfirmedIds: ['A3'] });
    expect(restore(saved(review))?.reviewStop).toEqual({ ...executionStop, unconfirmedIds: ['A3'] });
    expect(historical).toEqual(snapshot);
    expect(normalizeReview({ ...historical, issues: [], acceptance: historical.acceptance!.map((item) => ({ ...item, status: 'unconfirmed' as const })) }).evidenceIssues).toBeUndefined();
  });
});
