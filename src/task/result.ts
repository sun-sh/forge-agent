import { z } from 'zod';
import type { TaskState } from './controller.js';
import { acceptanceSatisfied } from './plan.js';
import { isVerified, isVerificationUnconfigured } from '../verification/pi-extension.js';
import { behaviorCurrent, behaviorHash } from './behavior.js';
import { reviewStop, reviewStopSchema } from './review.js';


export const taskResultSchema = z.object({
  version: z.literal(1),
  status: z.enum(['in_progress', 'blocked', 'implemented_unverified', 'finished_unverified', 'not_applicable']),
  execution: z.enum(['running', 'blocked', 'finished']),
  acceptance: z.enum(['unverified', 'not_applicable']),
  resolutionClaimed: z.literal(false),
  checks: z.enum(['passed', 'not_configured', 'not_run', 'running', 'failed', 'unconfirmed']),
  modelReview: z.enum(['passed', 'not_applicable', 'not_run', 'unconfirmed', 'changes_requested', 'insufficient_evidence', 'budget_exhausted']),
  behaviorChecks: z.enum(['not_run', 'running', 'passed', 'failed', 'unconfirmed']).optional(),
  reviewStop: reviewStopSchema.optional()
}).strict();
export type TaskResult = z.infer<typeof taskResultSchema>;

/** Product result, separate from the legacy scheduler status `completed`.
 * No current Forge source attests to complete behavioral acceptance. Neither
 * arbitrary configured commands nor a model review may claim resolution.
 * Derive on read so persisted/legacy flags cannot upgrade the claim.
 */
export function taskResult(task: TaskState) {
  const verification = task.verification;
  const checks = isVerified(verification) ? 'passed' as const
    : isVerificationUnconfigured(verification) ? 'not_configured' as const
    : verification?.status === 'failed' ? 'failed' as const
    : verification?.status === 'running' ? 'running' as const
    : verification?.status === 'passed' || verification?.evidence ? 'unconfirmed' as const : 'not_run' as const;
  const review = task.review;
  const behaviorPassed = (!task.behavior || task.behavior.requestSha256 === behaviorHash(task.prompt)) && behaviorCurrent(task.behavior, verification?.evidence?.workspace.digest);
  const stop = task.reviewStop ?? (task.reviewFollowup || review ? reviewStop(task.reviewFollowup ?? review!, task.plan?.acceptance.map((item) => item.id)) : undefined) ?? (task.behavior && !behaviorPassed && task.status !== 'running' ? { reason: 'insufficient_evidence' as const, action: 'provide_evidence' as const, issueCount: 0, unconfirmedIds: [] } : undefined);
  const reviewed = behaviorPassed && review?.verdict === 'ready' && !review.issues.length && !task.reviewFollowup && !task.reviewStop
    && review.freshness === 'current' && checks === 'passed' && Boolean(verification?.evidenceId)
    && review.evidenceId === verification?.evidenceId && acceptanceSatisfied(task.plan, review.acceptance);
  const modelReview = task.reviewRequired === false ? 'not_applicable' as const : reviewed ? 'passed' as const
    : stop?.reason === 'budget_exhausted' ? 'budget_exhausted' as const : stop?.reason === 'insufficient_evidence' ? 'insufficient_evidence' as const : stop?.reason === 'code_defects' || task.reviewFollowup || review?.issues.length || review?.verdict === 'changes_requested'
    ? 'changes_requested' as const : review ? 'unconfirmed' as const : 'not_run' as const;
  const readOnly = ['ask', 'plan'].includes(task.mode ?? '') || ['answer', 'explore', 'verify'].includes(task.kind ?? '');
  const implementation = !readOnly && (task.kind === 'change' || Boolean(task.artifacts?.length) || Boolean(task.changes?.files.some((file) => file.observed)));
  const running = task.status === 'running' || task.status === 'completed' && task.finalization === 'pending';
  const blocked = !running && (task.status !== 'completed' || Boolean(task.error) || task.finalization === 'failed'
    || verification?.protection && verification.protection.status !== 'unchanged'
    || !behaviorPassed || checks === 'failed' || checks === 'unconfirmed' || Boolean(stop) || modelReview === 'changes_requested'
    || task.workflow === 'planned' && task.kind === 'change' && checks !== 'not_configured' && (checks !== 'passed' || task.reviewRequired !== false && !reviewed));
  return taskResultSchema.parse({
    version: 1,
    status: running ? 'in_progress' as const : blocked ? 'blocked' as const
      : readOnly ? 'not_applicable' as const : implementation ? 'implemented_unverified' as const : 'finished_unverified' as const,
    execution: running ? 'running' as const : blocked ? 'blocked' as const : 'finished' as const,
    acceptance: readOnly ? 'not_applicable' as const : 'unverified' as const,
    resolutionClaimed: false as const,
    checks,
    modelReview,
    ...(task.behavior ? { behaviorChecks: task.behavior.status === 'pending' ? 'not_run' as const : task.behavior.status === 'passed' && !behaviorPassed ? 'unconfirmed' as const : task.behavior.status } : {}),
    ...(stop && !reviewed ? { reviewStop: stop } : {})
  });
}

export function publicTask<T extends TaskState>(task: T): Omit<T, 'result'> & { result: TaskResult } {
  return { ...task, result: taskResult(task) };
}
