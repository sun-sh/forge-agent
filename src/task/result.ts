import type { TaskState } from './controller.js';
import { acceptanceSatisfied } from './plan.js';
import { isVerified, isVerificationUnconfigured } from '../verification/pi-extension.js';

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
  const reviewed = review?.verdict === 'ready' && !review.issues.length && !task.reviewFollowup
    && review.freshness === 'current' && checks === 'passed' && Boolean(verification?.evidenceId)
    && review.evidenceId === verification?.evidenceId && acceptanceSatisfied(task.plan, review.acceptance);
  const modelReview = task.reviewRequired === false ? 'not_applicable' as const : reviewed ? 'passed' as const : task.reviewFollowup || review?.issues.length || review?.verdict === 'changes_requested'
    ? 'changes_requested' as const : review ? 'unconfirmed' as const : 'not_run' as const;
  const readOnly = ['ask', 'plan'].includes(task.mode ?? '') || ['answer', 'explore', 'verify'].includes(task.kind ?? '');
  const implementation = !readOnly && (task.kind === 'change' || Boolean(task.artifacts?.length) || Boolean(task.changes?.files.some((file) => file.observed)));
  const running = task.status === 'running' || task.status === 'completed' && task.finalization === 'pending';
  const blocked = !running && (task.status !== 'completed' || Boolean(task.error) || task.finalization === 'failed'
    || verification?.protection && verification.protection.status !== 'unchanged'
    || checks === 'failed' || checks === 'unconfirmed' || modelReview === 'changes_requested'
    || task.workflow === 'planned' && task.kind === 'change' && checks !== 'not_configured' && (checks !== 'passed' || task.reviewRequired !== false && !reviewed));
  return {
    version: 1 as const,
    status: running ? 'in_progress' as const : blocked ? 'blocked' as const
      : readOnly ? 'not_applicable' as const : implementation ? 'implemented_unverified' as const : 'finished_unverified' as const,
    execution: running ? 'running' as const : blocked ? 'blocked' as const : 'finished' as const,
    acceptance: readOnly ? 'not_applicable' as const : 'unverified' as const,
    resolutionClaimed: false as const,
    checks,
    modelReview
  };
}

export function publicTask<T extends TaskState>(task: T): Omit<T, 'result'> & { result: ReturnType<typeof taskResult> } {
  return { ...task, result: taskResult(task) };
}
