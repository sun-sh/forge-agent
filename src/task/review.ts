import { z } from 'zod';
import { acceptanceReviewSchema, parseHandoffJson, type AcceptanceReview } from './plan.js';

export interface TaskReview {
  verdict: 'ready' | 'changes_requested'; summary: string; issues: string[]; notes?: string[]; acceptance?: AcceptanceReview;
  freshness?: 'current' | 'stale' | 'unconfirmed'; evidenceId?: string;
}
const findings = z.array(z.string().min(1).max(4000)).max(50);
export const reviewSchema = z.object({ verdict: z.enum(['ready', 'changes_requested']), summary: z.string().min(1).max(8000), issues: findings, notes: findings.optional(), acceptance: acceptanceReviewSchema.optional() }).strict();
export function parseReview(text: string): TaskReview | undefined {
  try { return reviewSchema.parse(parseHandoffJson(text, 100_000)); } catch { return undefined; }
}
export class ReviewFormatError extends Error {}
/** The independent gate stopped at its own bounded child budget. */
export class ReviewBudgetExceededError extends Error {
  constructor(message: string) { super(message); this.name = 'ReviewBudgetExceededError'; }
}
export const REVIEW_FORMAT_RETRY = 'HOST REVIEW FORMAT CORRECTION — This is the only format retry, in the same independent review session and budget. Your last answer did not match the review JSON schema. Return ONLY one JSON object without Markdown or prose: {"verdict":"ready"|"changes_requested","summary":"...","issues":["blocking defect"],"notes":["optional observation"],"acceptance":[{"id":"A1","status":"met"|"unmet"|"unconfirmed","evidence":"specific supporting evidence"}]}. Keep your evidence-based findings and the original acceptance IDs. Do not invent passing evidence or change the goal to make the format valid. When evidence is insufficient, record unconfirmed and changes_requested. No mutation or command execution is permitted.';
