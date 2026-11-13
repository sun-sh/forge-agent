# Paired reviewer mechanism diagnostic — 2026-11-13

The [allowlisted aggregate](review-counterexamples-2026-11-13.json) retains all 24 real-model decisions. **Both prompt policies made all label decisions correctly. No defect-detection improvement is demonstrated.** These are two synthetic mechanisms, not upstream Flask/Matplotlib patches, a coding benchmark or 24 independent tasks.

## Protocol and identity

Two fixed dependency-free cases in scripts/review-cases.mjs cover endpoint validation lost while adding a group-name check, and blanket 2D rejection breaking supported Nx1 inputs despite a conflicting implementer ledger. Each has correct/defective candidates. Before model requests, both variants pass limited visible checks; the external oracle accepts correct and rejects defective candidates (4/4 validation). Labels and oracle code stay outside the supplied reviewer context. Reader tools still have the launching user's OS permissions; this is not a claim that files outside the candidate are inaccessible through an OS sandbox.

Each candidate is reviewed under baseline-v1/focused-v2 three times, with cyclic counterbalancing. baseline-v1 reconstructs an earlier verbose prompt; it is not an executable frozen old release. Both policies use the same current restricted read-only Pi child runtime and standard limits. The captured harness/suite/source-report fingerprints bind the measurement. Its base revision includes working-tree changes; a later cancellation-only guard is not covered by these samples.

Configured model: deepseek/deepseek-v4.1-flash; openai-completions; medium effort. Local service identity/endpoints are omitted. This is not claimed equivalent to the official-service setup of previous SWE-bench runs. Pricing is unavailable; dollar cost stays unknown. The aggregate separately records parent limits, environment, standard reviewer limits and explicit 60-second oracle/Git subprocess bounds. Those bounds do not enlarge model budgets.

## Results

| Metric | baseline-v1 | focused-v2 |
| --- | ---: | ---: |
| Reviews | 12 | 12 |
| Defective candidates blocked | 6/6 | 6/6 |
| Correct candidates accepted | 6/6 | 6/6 |
| Misses / false blockers / abstentions | 0 / 0 / 0 | 0 / 0 / 0 |
| Model turns | 35 | 31 |
| Request tokens | 141,170 | 125,527 |
| Output tokens | 22,627 | 17,279 |
| Total review time | 528.8 s | 446.6 s |
| Dollar cost | Unknown | Unknown |

Maximum turns in any review: 4. No run approaches 24 turns. This diagnostic gives no evidence that the extended 40-turn/$6 ceiling is necessary. Product defaults remain 24 turns/$4, with explicit opt-in for extended limits. Lower observed totals on these repeated tiny cases are descriptive, not a general efficiency claim.

## Retained failures and limits

The first local attempt failed in its first external-oracle subprocess, before model requests or recording a candidate outcome. Its source hash and zero-review count are retained. The original error lacked exit/signal detail, so its exact cause is unconfirmed; a separately fingerprinted retry with explicit 60-second bounds validated 4/4 and completed 24 reviews. This is infrastructure history, not model failure or a hidden excluded row.

The old 45-run SWE-bench ablation and Astropy/SymPy runs are unchanged. These simple mechanism analogues do not demonstrate improved detection of retained upstream misses, general precision/recall, or a reason for default hard review. Frozen upstream-patch replay and repeated official end-to-end grading remain outstanding. Label-level decisions do not prove every textual finding correct. Raw local configuration, endpoints, credentials and user-specific paths are excluded.

## 中文结论

两个机制各有正确/错误候选，两个提示各重复三次，共 24 次真实审阅。两组都识别 6/6 错误候选、接受 6/6 正确候选，没有观察到漏检、误阻断或弃权，也**没有测出新提示的判断增益**。单次最多 4 回合，没有证明需要 40 回合。它们是模拟反例，不是实际上游补丁；原 Flask/Matplotlib 失败仍未证明改善。首轮在外部 oracle 子进程阶段失败、零模型请求，失败记录单独保留。预算、代码快照和价格未知的边界均写入汇总。
