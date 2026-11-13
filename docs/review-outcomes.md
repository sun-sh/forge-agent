# Review outcomes and limits / 审阅结果与边界

The host persists `task.reviewStop` and exports it as `task.result.reviewStop`. The same strict Zod schema validates the reason, recovery action, issue count, unconfirmed IDs and optional budget scope. Child review records carry the same fields; budget failures also have `errorCode=budget_exhausted`. Task scheduling still uses `needs_attention`/`budget_exceeded`; consumers use the structured review outcome to explain what happened.

| Reason | Meaning / 界面 | Action |
| --- | --- | --- |
| `budget_exhausted` | 审阅未完成；未得出代码结论 | `adjust_budget`: adjust the reviewer or parent limit, identified by `budgetScope`, then retry |
| `insufficient_evidence` | 需求未验收；无法判断 | `provide_evidence`: supply relevant checks/evidence or perform manual acceptance |
| `code_defects` | 审阅发现 N 个问题 | `fix_code`: inspect findings and unmet requirements, repair and reverify |
| `invalid_review` | 无效的结构化审阅 | `retry_review`: inspect/retry after the one format correction |
| `review_failed` | 审阅运行错误 | `retry_review`: inspect the actual provider/runtime failure |

The model contract adds `verdict=insufficient_evidence`, with empty issues and no unmet items. Concrete issues or unmet behavior remain `changes_requested`. Legacy changes_requested plus empty issues and unconfirmed acceptance is normalized to insufficient_evidence; it does not invent defects or passing evidence. Unknown/duplicate acceptance IDs remain invalid, not a new implementation request. The host's one evidence follow-up still consumes shared verifyRetries, survives recovery and must be followed by current verification and a fresh reviewer.

`modelReview` additionally exposes `budget_exhausted` and `insufficient_evidence`; concrete defects retain `changes_requested` for compatibility. All variants are schema-validated. Model-ready is still not externally resolved, and product behavioral acceptance remains unverified.

## Budget policy

Default reviewer limits return to 5 minutes, 24 model turns, 120 tools, 32,000 output tokens and $4. Settings → About → Execution budget provides explicit extended opt-in: 8 minutes, 40 turns, 160 tools, 48,000 output tokens and $6. It is saved under `web-settings.json` as `reviewBudget=standard|extended`, outside project verification configuration. Missing older fields select standard. A run captures its selection before execution; parent limits and cancellation always apply. Unknown prices remain unknown and a host dollar threshold is not a billing guarantee.

The [two targeted runs](evaluations/review-budget-evidence-2026-11-13.md) used only 3/5 and 4/5 reviewer turns. They establish neither the necessity of 40 turns nor a causal quality gain. The 26-turn fixture proves opt-in mechanics only. Historical measurements and budget identities remain unchanged.

## Missed-defect work and evidence boundaries

Denominators stay distinct: the historical Direct arm finished 15/15 with 9/15 officially resolved and six false completions, but it did not run a reviewer. Planned finished nine runs, five of which were correct completed deliveries; four finished patches failed official grading and four correct patches were blocked. Direct's six errors must not be relabeled as six reviewer false negatives. Neither set is erased by the new outcome vocabulary.

The [old ablation](evaluations/swebench-ablation-2026-11-12.md) retains Flask/Matplotlib misses. Current instructions require deriving behavior from the original issue before assessing the model-authored plan, tracing explicit argument overrides/public entry paths, and preserving supported shapes and boundary cases. A green broad suite does not establish that the issue trigger was exercised. A concrete counterexample is a defect; unresolved behavior is insufficient evidence.

Two dependency-free paired candidates in `scripts/review-cases.mjs` cover endpoint validation lost while adding a new name check, and blanket 2D rejection breaking Nx1 support despite a misleading model ledger. Both defective candidates pass their visible checks and fail external assertions; correct variants pass both. These are **synthetic mechanism analogues**, not Flask/Matplotlib upstream patches or official SWE-bench results. `npm run eval:review -- --case endpoint-override-regression,column-vector-regression --validate-only` validates oracles without a model. Real mode measures reviewer decisions separately, retaining misses, false positives, abstentions, budgets and fingerprints. Scripted oracles/fixtures cannot establish reviewer quality.

No claim is made that the historical Flask/Matplotlib failures are repaired, or that relaxing false blockers makes a trustworthy gate. Frozen upstream-patch review and repeated end-to-end grading remain separate necessary measurements. Adaptive remains the default workflow.

## 中文

旧实现确有预算异常类型、错误文案和 unconfirmed 验收项，但没有对用户统一表达三种原因；先前把它说成已完成三分类是不准确的。现在原因、恢复动作和验收 ID 同时进入持久化、API 和界面，证据不足有独立 verdict。标准预算恢复 24 回合/$4，40 回合/$6 由用户显式开启。原两轮 n=1 只验证路径，不证明扩大预算有效；漏检案例仍保留为未验证改善，新反例与实际上游成绩分别报告。

The [24-review real-model diagnostic](evaluations/review-counterexamples-2026-11-13.md) detects both synthetic mechanisms under both prompts with no observed decision gain. It does not demonstrate repair of upstream misses or a need for extended budgets.
