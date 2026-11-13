# Reviewer budgets and evidence regression — 2026-11-13

The [allowlisted aggregate](review-budget-evidence-2026-11-13.json) retains both new real-model runs, including the first run's blocked correct SymPy patch. The later run resolves and completes both issues; it does not establish a general review-quality or efficiency gain.

## Protocol and identity

- Same frozen Astropy 6938 / SymPy 18189 subset and official SWE-bench harness as the [previous regression](review-command-evidence-2026-11-12.md). Each revision has one fresh model sample per issue; these are not replays of identical implementation patches.
- Model ID: deepseek-flash; OpenAI Completions protocol; medium reasoning. Both runs validate baseline/reference 2/2 before model calls. Hidden tests and gold patches stay outside model workspaces.
- Parent limits stay 30 minutes, 160 model turns, 400 tools, 200,000 output tokens and $50; the cumulative request-token cap is disabled. Configured visible checks cover changed-Python syntax only. Protected tests/configuration and independent official grading remain required.
- Reviewer limits are 8 minutes, 40 turns, 160 tools, 48,000 output tokens and $6, still charged to the parent. Actual model pricing is unavailable; dollar costs remain unknown.
- Run 1: [43367262320](https://github.com/sun-sh/forge-agent/actions/runs/43367262320), revision aa06158d152224b71e0569271b14aae386c475be; larger budget and categorized, prioritized historical receipts, but an overly strict missing-receipt prompt.
- Run 2: [43382266784](https://github.com/sun-sh/forge-agent/actions/runs/43382266784), revision d49d727b8f495395cd4f8647399f4037c70d657a; the prompt treats missing exact reproduction receipts as limitations to assess alongside code rather than automatic blockers. Exact source-report, package, patch, snapshot, harness, model-configuration, validation and image fingerprints are in the aggregate.

## Results

| Run | Instance | Official resolved | Forge completed | Reviewer turns | Repairs | Execution seconds |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 1 | astropy__astropy-6938 | yes | yes | 3 | 0 | 276.9 |
| 1 | sympy__sympy-18189 | yes | no | 5 | 0 | 207.7 |
| 2 | astropy__astropy-6938 | yes | yes | 4 | 0 | 398.3 |
| 2 | sympy__sympy-18189 | yes | yes | 5 | 0 | 103.5 |

Run 1 officially resolves 2/2 but completes delivery only 1/2. SymPy's reviewer recognizes the passing native suite/doctest receipts and the correct recursive flag forwarding, yet marks A1–A3 unconfirmed solely because a direct reproduction receipt is missing. It reports no concrete issue, and the then-current controller does not launch a repair for an empty issues list. This is a completion-gate workflow failure, not infrastructure failure or an unresolved patch.

Run 2 officially resolves and delivers 2/2, with zero repairs, integrity violations, false completions or infrastructure failures. Both reviewers finish in four/five turns. SymPy now has inline reproduction evidence as well as the repository-native test run; Astropy's reviewer distinguishes the expected legacy checksum change from unrelated environment failures. Failed receipt observations remain disclosed in review notes. Product results remain implemented_unverified with unverified acceptance and no resolution claim; external official resolution is a separate measurement.

The second run's implementation, generated acceptance and test evidence also differ. Its success cannot be attributed solely to the prompt, and neither run needs more than the former 24-turn allowance. Deterministic Pi tests separately exercise successful completion at turn 26 and stopping at the new 40-turn cap. Larger budget support is established as an engineering behavior, not a measured cause of quality gains.

## Evidence-only follow-up after these measurements

Current source additionally gives a complete, unique ledger containing only met/unconfirmed items and no concrete issues one bounded parent-session evidence follow-up. It consumes shared verifyRetries, persists consumption across continuation/restart, reruns current verification and creates a fresh reviewer. Missing/duplicate IDs, unmet items, stale evidence or exhausted allowances cannot trigger it. These two model runs predate that branch and do not validate it. Its host-state and Pi shell-to-fresh-reviewer integration regressions must be reported as engineering evidence.

The old 45-run ablation and the earlier 2/2 command-evidence regression remain unchanged. This targeted result does not justify enabling review by default, certify unseen requirements, repair the six Flask/Matplotlib failures or replace a repeated three-arm evaluation. Raw local artifacts remain ignored; only allowlisted metadata is published here.

## 中文结论

本次保留两轮各两题的真实模型执行：第一轮官方通过 2/2、Forge 交付 1/2，SymPy 仍因缺少精确复现回执而误阻断；调整该过严规则后，第二轮官方通过且交付 2/2。第二轮的补丁和测试证据也发生变化，因此不能把结果全部归因于提示修复。两轮都没有保护违规或基础设施失败，费用未知。当前新增的有界补证分支在两轮之后实现，只有工程回归，不继承它们的真实模型成绩；旧失败与 45 次消融继续保留。
