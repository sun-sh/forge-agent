import type { BehaviorState } from './behavior.js';
import { allBehaviorChecksNonDiscriminating } from './behavior.js';
import type { TaskPlan } from './plan.js';
import { reviewStop, type TaskReview } from './review.js';

export const NON_DISCRIMINATING_REVIEW_LIMIT = '宿主证据约束：全部冻结检查的基线与候选退出状态、输出哈希相同，不能确认本次补丁效果。命令执行记录仍保留；这不表示发现了代码缺陷。';

/** A monotone host guard, not a second reviewer or a behavioral correctness oracle. */
export function constrainReviewDiscrimination(review: TaskReview, plan: TaskPlan | undefined, behavior: BehaviorState | undefined): TaskReview {
  if (!plan || !allBehaviorChecksNonDiscriminating(behavior) || review.verdict !== 'ready'
    || reviewStop(review, plan.acceptance.map(item => item.id))) return review;
  // The raw model review remains in its independent child record. Do not manufacture
  // a defect or a B-to-A coverage mapping from model-authored requirement prose.
  return {
    ...review, verdict: 'insufficient_evidence', summary: NON_DISCRIMINATING_REVIEW_LIMIT,
    acceptance: review.acceptance?.map(item => ({...item, status:'unconfirmed', evidence:NON_DISCRIMINATING_REVIEW_LIMIT}))
  };
}
