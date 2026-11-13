import { z } from 'zod';
import { acceptanceReviewSchema, parseHandoffJson, type AcceptanceReview } from './plan.js';

export interface TaskReview {
  verdict: 'ready' | 'changes_requested' | 'insufficient_evidence'; summary: string; issues: string[]; notes?: string[]; acceptance?: AcceptanceReview;
  freshness?: 'current' | 'stale' | 'unconfirmed'; evidenceId?: string;
}
const findings = z.array(z.string().min(1).max(4000)).max(50);
export const reviewSchema = z.object({ verdict: z.enum(['ready', 'changes_requested', 'insufficient_evidence']), summary: z.string().min(1).max(8000), issues: findings, notes: findings.optional(), acceptance: acceptanceReviewSchema.optional() }).strict();
export const reviewStopSchema = z.object({
  reason: z.enum(['budget_exhausted', 'insufficient_evidence', 'code_defects', 'invalid_review', 'review_failed']),
  action: z.enum(['adjust_budget', 'provide_evidence', 'fix_code', 'retry_review']),
  issueCount: z.number().int().min(0).max(62),
  unconfirmedIds: z.array(z.string().regex(/^A(?:[1-9]|1[0-2])$/)).max(12),
  budgetScope: z.enum(['reviewer', 'parent']).optional()
}).strict().superRefine((value, ctx) => {
  const actions = { budget_exhausted: 'adjust_budget', insufficient_evidence: 'provide_evidence', code_defects: 'fix_code', invalid_review: 'retry_review', review_failed: 'retry_review' } as const;
  if (value.action !== actions[value.reason]) ctx.addIssue({ code: 'custom', path: ['action'], message: 'Review reason and recovery action do not match' });
  if (value.reason === 'code_defects' ? value.issueCount === 0 : value.issueCount !== 0) ctx.addIssue({ code: 'custom', path: ['issueCount'], message: 'Only concrete defects carry a nonzero issue count' });
});
export type ReviewStop = z.infer<typeof reviewStopSchema>;
/** Legacy evidence-only changes_requested responses remain readable, never become defects. */
export function normalizeReview(review: TaskReview): TaskReview {
  return review.verdict === 'changes_requested' && !review.issues.length && review.acceptance?.some((item) => item.status === 'unconfirmed')
    && !review.acceptance.some((item) => item.status === 'unmet') ? { ...review, verdict: 'insufficient_evidence' } : review;
}
export function reviewStop(review: TaskReview, acceptanceIds: readonly string[] = []): ReviewStop | undefined {
  const findings = review.acceptance ?? [];
  if (new Set(findings.map((item) => item.id)).size !== findings.length || acceptanceIds.length && findings.some((item) => !acceptanceIds.includes(item.id)))
    return { reason: 'invalid_review', action: 'retry_review', issueCount: 0, unconfirmedIds: [] };
  const unconfirmedIds = [...new Set([...findings.filter((item) => item.status === 'unconfirmed').map((item) => item.id), ...acceptanceIds.filter((id) => !findings.some((item) => item.id === id))])];
  const unmet = findings.filter((item) => item.status === 'unmet').length;
  if (review.issues.length || unmet) return reviewStopSchema.parse({ reason: 'code_defects', action: 'fix_code', issueCount: Math.max(review.issues.length, unmet), unconfirmedIds });
  if (review.verdict === 'insufficient_evidence' || unconfirmedIds.length) return reviewStopSchema.parse({ reason: 'insufficient_evidence', action: 'provide_evidence', issueCount: 0, unconfirmedIds });
  if (review.verdict !== 'ready' || new Set(findings.map((item) => item.id)).size !== findings.length
    || acceptanceIds.length && (findings.length !== acceptanceIds.length || findings.some((item) => !acceptanceIds.includes(item.id))))
    return { reason: 'invalid_review', action: 'retry_review', issueCount: 0, unconfirmedIds: [] };
  return undefined;
}
export function parseReview(text: string): TaskReview | undefined {
  try {
    const review = reviewSchema.parse(parseHandoffJson(text, 100_000));
    if (review.verdict === 'insufficient_evidence' && (review.issues.length || review.acceptance?.some((item) => item.status === 'unmet'))) return undefined;
    return normalizeReview(review);
  } catch { return undefined; }
}
export class ReviewFormatError extends Error {}
/** The independent gate stopped at its own bounded child budget. */
export class ReviewBudgetExceededError extends Error {
  constructor(message: string, readonly sessionId?: string, readonly model?: string) { super(message); this.name = 'ReviewBudgetExceededError'; }
}
export const REVIEW_FORMAT_RETRY = 'HOST REVIEW FORMAT CORRECTION — This is the only format retry, in the same independent review session and budget. Your last answer did not match the review JSON schema. Return ONLY one JSON object without Markdown or prose: {"verdict":"ready"|"changes_requested"|"insufficient_evidence","summary":"...","issues":["blocking defect"],"notes":["optional observation"],"acceptance":[{"id":"A1","status":"met"|"unmet"|"unconfirmed","evidence":"specific supporting evidence"}]}. Keep your evidence-based findings and the original acceptance IDs. Do not invent passing evidence or change the goal to make the format valid. When evidence is insufficient without a concrete defect, record unconfirmed, insufficient_evidence and empty issues. No mutation or command execution is permitted.';
