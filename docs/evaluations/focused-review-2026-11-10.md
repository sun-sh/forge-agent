# Focused review and workflow simplification — 2026-11-10

The aim is to reduce host-induced work while preserving completion gates. Earlier clean-task ablations did not show an independent-review quality benefit, and the later injected-defect challenge was a mechanism diagnostic. Those original results remain separate. This batch tests a narrower hypothesis: can a smaller review handoff retain the same decisions on fixed candidates while consuming fewer resources?

## Paired reviewer diagnostic

The [allowlisted aggregate](deepseek-focused-review-2026-11-10.json) retains every result and the protocol fingerprints. Before any model request, external Node assertions validated six candidates: correct and defective versions for configuration normalization, strict port parsing, and stable deduplication. Both versions pass the deliberately limited visible check. The external oracle accepts each correct candidate and rejects each defective candidate (6/6 validation). Correctness labels and external oracles never enter reviewer prompts; candidate directories have random names.

Each candidate is reviewed by a fresh read-only Pi session under both policies. `baseline-v1` reconstructs the earlier verbose prompt; `focused-v2` uses one complete requirement ledger and the same complete patch, asking the reviewer to read only specific missing context. Both run on the current restricted child runtime, with the same DeepSeek V4.1 Flash model, medium reasoning, and fixed parent/child limits. This compares prompts, not entire product releases. Calls run sequentially, with cyclic counterbalancing across candidates. There is one repetition per candidate/policy.

| Policy | Defects blocked | Correct candidates accepted | False positives | Misses / abstentions | Model turns | Request tokens | Generated tokens | Total elapsed |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| baseline-v1 | 3/3 | 3/3 | 0/3 | 0 / 0 | 27 | 114,746 | 11,050 | 162.3 s |
| focused-v2 | 3/3 | 3/3 | 0/3 | 0 / 0 | 21 | 77,315 | 8,311 | 117.0 s |

For these six candidates, request tokens fell by **32.6%** and generated tokens by **24.8%**, with the same observed decisions. The total handoff text fell from 36,566 to 23,138 characters. Elapsed time is descriptive: one pass, caching and provider variability do not support a general speed claim. Pricing was unavailable, so dollar cost is unknown. Request-token totals include repeated context and cache reads.

The three defects are a clamped invalid retry count instead of a default, rejection of the valid upper port boundary, and returning the original array when no duplicates exist. The correct variants help detect false positives. A blocking decision on a labelled defective candidate does not establish that every textual observation is correct. This sample does not establish general reviewer accuracy, natural-task gains, or superiority over another agent.

Suite fingerprint: `f83bca3ed590e20932203157bf2a784206d649d3d742eafd50c4b4dfcc02aa7e`.
Harness fingerprint: `0f7950fc82014011237058a6ecf3a441bbf713440ada1e2fdbd53ade7febd368`.
Environment: Windows x64, Node 24.19.0, Pi 1.4.0. The aggregate records effective parent and child limits. Raw findings remain in local diagnostic artifacts; credentials, endpoints and user-specific paths are excluded from the public aggregate.

## Clean natural task: three workflows, three repetitions

A separate [allowlisted clean-task aggregate](deepseek-clean-ablation-2026-11-10.json)
runs `config-normalize-cross-file` without injected defects through each workflow
three times, with the same model/medium effort and explicit budget: 10 minutes,
80 model turns, 160 tool calls, 40,000 generated tokens, no cumulative token stop,
and a configured USD 10 ceiling (actual billing unknown). Order rotates over
three repetitions so every arm occupies each position once. Execution time
excludes setup; total latency is retained separately.

| Workflow | Passed | False completions | Median execution | Request tokens, all 3 runs | Review activations |
| --- | ---: | ---: | ---: | ---: | ---: |
| direct | 3/3 | 0 | 37.3 s | 112,177 | 0 |
| planned | 3/3 | 0 | 74.9 s | 228,889 | 3 |
| planned-no-review | 3/3 | 0 | 64.1 s | 213,414 | 0 |

All six planned/no-review executions supplied a combined inspect/plan handoff;
none required a separate planning model call. All external assertions,
protection checks, current verification and host completion gates passed. No
review repair was required. This validates the shortened path without showing a
natural-task quality gain. The adaptive default remains appropriate for this
simple task; extra review remains an explicit opt-in. Earlier one-run timings
cannot be used as a controlled before/after speed comparison.

Clean-task harness fingerprint: `d0104e180773a6b76b2363a233e79270925f73b2f1777e7adeca2177140df71d`.
Suite fingerprint: `1bcbae8b34042e4e`.
Later persistence hardening has separate regression coverage and is not
retrospectively claimed as measured by this run.

## Runtime changes

Inspection can now return bounded implementation steps alongside goals, constraints and acceptance. The host derives the plan from that one handoff and retains the separate planning call as a fallback for legacy replies. Every repair still runs configured verification and a fresh independent reviewer; that reviewer gets the previous blocking findings and the complete original acceptance ledger. Nothing is completed by reusing an old review.

Missing verification is a separate state, with no Git-only review detour for a new unconfigured project. Existing blocking review findings cannot be erased by removing checks, and failed/budget/finalization states cannot be hidden behind an unconfigured label.

## 中文说明

这轮优先减少流程成本。调研和简短计划可以一次交接完成；缺少步骤时才补规划。独立审阅只携带一份完整要求及完整补丁，修复后的新 reviewer 收到前次阻断问题，但仍需覆盖全部原验收条件。

真实 DeepSeek 配对诊断覆盖 3 类任务、各一份正确/缺陷补丁、两版审阅策略，共 12 次调用。两版均发现 3/3 缺陷、接受 3/3 正确补丁，没有观察到误报或弃权。新版累计请求 token 减少 32.6%，生成 token 减少 24.8%。这支持该小样本里的开销下降，不能宣传为自然任务质量提升或通用审阅精度。

旧故障注入实验继续保留，不与这里的配对诊断或自然任务消融合并计算。
