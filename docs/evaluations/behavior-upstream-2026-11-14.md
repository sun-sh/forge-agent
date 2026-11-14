# Frozen upstream behavioral-gate qualification — 2026-11-14

This diagnostic evaluates four unchanged historical Planned patches in their original task images. It is a qualification of check design, native execution and product decisions, not a new coding run or SWE-bench resolution score. Earlier failures remain in separate immutable aggregates.

## Protocol and identities

The protocol is [frozen-upstream-native-behavior-v1](../../evals/swebench-lite/behavior-replay.json), documented in [the replay guide](../upstream-behavior-replay.md). Original implementations come from Actions run 43184349339 and separate unchanged-patch official grading from 43196437456. Each original image manifest/config ID, effective HEAD, patch, snapshot and official report is pinned before model execution.

The designer receives only the original issue and navigation hints in a fresh read-only Pi session against unpatched source. After design, the driver injects the fixed patch. Actual parent Pi tools execute frozen checks, current configured syntax/protection checks run, and a new independent reviewer contributes its verdict. Inspection and implementation are scripted; no repairs or candidate resampling occur. Selected historical command observations are labeled as historical in the review handoff. Official reports, hidden tests, old reviews and implementation transcripts stay outside the model context. Official labels below remain historical labels of the unchanged patches; this diagnostic does not run the official grader again.

The model catalog ID is benchmark/deepseek-flash, openai-completions, medium effort; underlying service settings cannot be established from the alias alone. Pi is 1.4.0, Node is 22.21.1 and task containers are Linux/amd64. Prices are unknown, so dollar costs remain unknown. A configured dollar limit is not a billing guarantee. The parent allows 20 minutes/80 turns/200 tools/100k output tokens, the designer three minutes/12 turns/60 tools/16k output tokens and the standard reviewer five minutes/24 turns/120 tools/32k output tokens. Child use is also counted against the parent.

## Retained infrastructure attempt

Actions run **43568915572**, revision **70cbbf85dbc6d095b03a0c7ecd3c2297b8be649b**, fails all four workers before task design/execution because host-owned mode-0600 credential files copied into capability-restricted containers are unreadable. Provider preflight had already made a small model request; this is not a zero-model-call attempt. The [infrastructure aggregate](behavior-upstream-2026-11-14.infrastructure.json) retains all outcomes. Writing configuration through stdin as the container user, with umask 077, fixes ownership without exposing values in arguments/logs.

## First completed four-case attempt

Actions run **43569394614**, revision **6737b39bfbae606f79547c436751091c2083aa02**, runs all four unchanged candidates with protection unchanged and no transport/integrity failure. The [initial aggregate](behavior-upstream-2026-11-14.initial.json) retains actual plans, receipts, budgets and code/harness/package fingerprints. An integrity-qualified candidate means identity and protected-path checks hold; it does not mean the patch is correct.

| Fixed candidate | Historical official label | Native behavior evidence | Product decision | Interpretation |
| --- | --- | --- | --- | --- |
| Flask 4045 | Failed | B1/B3 pass; B2 fails on Werkzeug test-client as_tuple mismatch | Blocked | Environment block; no demonstrated detection of the official endpoint-exception mismatch |
| Matplotlib 23563 | Failed | No plan/receipts; designer reaches 12-turn limit | Blocked | Missing check design; no demonstrated defect detection |
| Astropy 6938 | Passed | No plan/receipts; designer reaches 12-turn limit | Blocked | Correct candidate stopped |
| SymPy 18189 | Passed | No plan/receipts; designer exceeds 16k output allowance | Blocked | Correct candidate stopped |

All four final model reviewers say ready. The host prevents ready from overriding missing/failed native evidence, but **four stops are not four successful defect detections**. This attempt demonstrates no effective separation of the two officially failing and two officially passing candidates.

## Convergence change and separate rerun

Revision **5d3b7949665b5ebda2938b912b84e5bf85c96dcf** asks designers to start at supplied file hints, warns after six reads/searches, and closes the evidence collection window after ten. A native Pi turn can then return the structured plan or an explicit limitation. One schema-correction request retains the closed tool window. Hard turn, duration, output and cost limits are unchanged; the window does not guarantee completion before another budget is exhausted. This uses Pi extensions rather than introducing a model/tool loop.

The separate rerun is Actions **43571025712**. The [revised aggregate](behavior-upstream-2026-11-14.revised.json) retains all four unchanged candidates, full frozen plans/receipts and distinct fingerprints. There are no transport/integrity failures. All four final model reviewers return ready. New model samples and changed plans prevent a causal prompt-only quality comparison.

| Fixed candidate | Historical official label | Native behavior evidence | Product decision | Interpretation |
| --- | --- | --- | --- | --- |
| Flask 4045 | Failed | B1/B3 assert an incorrect Flask.add_url_rule baseline contract; B2 hits the same Werkzeug mismatch | Blocked | Invalid check expectations plus environment block; no demonstrated official-defect detection |
| Matplotlib 23563 | Failed | No frozen plan/receipts; designer crosses output allowance after ten reads | Blocked | Still unqualified; no demonstrated defect detection |
| Astropy 6938 | Passed | Three exit-zero receipts: D exponent writing, E-format preservation, multi-row numeric preservation | implemented_unverified | Correct candidate delivered with current native evidence |
| SymPy 18189 | Passed | Three exit-zero receipts: complete solutions across syms orders and quadratic boundaries | implemented_unverified | Correct candidate delivered with current native evidence |

The changed designer produces three valid plans instead of one in these samples. Both officially passing candidates deliver instead of stopping, but **neither historical failing candidate has a demonstrated concrete-defect catch**. The two stops must not be advertised as a 2/2 detection score or proof that false negatives are fixed.

| Designer | First attempt turns / reads / output tokens | Revised attempt turns / reads / output tokens |
| --- | --- | --- |
| Flask | 8 / 15 / 8,323 | 6 / 8 / 5,786 |
| Matplotlib | 13 / 17 / 2,185 | 8 / 10 / 18,246 |
| Astropy | 13 / 18 / 3,556 | 6 / 7 / 6,683 |
| SymPy | 12 / 15 / 20,582 | 10 / 10 / 7,734 |

Counts preserve native ledgers, including a refused thirteenth turn or the response crossing an output threshold. The ten-read collection boundary reduces one source of unbounded exploration; it does not reserve token headroom. Matplotlib demonstrates that limitation.

Flask illustrates a different limitation: the designer infers that Flask.add_url_rule rejects dotted endpoints, while the existing restriction belongs to Blueprint.add_url_rule. Its checks fail before testing the candidate's requested new guard. Native receipt attestation correctly preserves failure, but cannot establish whether the expected assertion is valid. The reviewer recognizes the bad expectation/environment issue and still reports ready; the host holds the task because its frozen behavioral evidence failed. Neither side detects the historical official endpoint-exception mismatch.

## Engineering validation and next decision

At measured runtime revision 5d3b794, Actions CI **43571025706** passes Windows/Ubuntu × Node 22/24: all four jobs pass 55 active test files (787 Windows / 784 Ubuntu cases) and clean package/CLI installation checks. Before the final closed-window-on-format-retry adjustment, four focused files pass 167 cases; the final adjustment then passes both native Pi read-window/format-correction cases, typecheck and build. The separate local full check is intentionally interrupted after 20.4 minutes without final suite counts (exit 1); typecheck, build and the subsequent CLI/bin checks pass. This is not a local full-suite pass. The [engineering record](behavior-upstream-engineering-2026-11-14.json) retains the log digest, source hashes and separate local/remote outcomes. Prior local timeouts and model failures remain unchanged. There is no new browser acceptance in this runtime-only follow-up.

The next qualification must validate check expectations and baseline/environment behavior, and preserve finalization headroom within the existing budgets. A failing process is insufficient to label a candidate defective. Use fixed known-good/known-bad controls without exposing official hidden assertions; retain abstentions rather than broadening the original issue to fit its official label. This evidence does not justify default independent behavioral review or another large coding ablation yet.

## Limits and interpretation

- Four selected patches with one sample per revision do not establish reliability, precision/recall, a general reviewer benefit or coding quality.
- A zero native exit attests process execution, not the correctness or completeness of model-authored expectations. Wrong baseline/API assumptions and environment failures must not be counted as source defects.
- The original issue may not specify all behavior expected by official hidden tests. Checks must not import a hidden expectation or broaden user scope to improve a retrospective score.
- Shared model budgets may stop a task, and usage is observed at native response boundaries. Saved ledgers preserve the request that crosses a threshold.
- Containers have no host mounts/sockets or added capabilities; Provider networking remains available. Project trust is not an OS sandbox.
- Product settlement still reports implemented_unverified and resolutionClaimed=false when checks/review pass. Retitling a status does not improve historical resolution.

## 中文

这轮固定四份真实旧补丁，在原始镜像中实际设计并执行检查。首轮全部阻断：Flask 是依赖环境问题，另外三个检查设计会话耗尽预算。收敛调整后的独立复测中，Astropy、SymPy 各三条行为命令通过并完成交付；Flask 的检查误认既有 API 约束且存在依赖兼容问题，Matplotlib 仍耗尽输出额度。两份失败补丁都没有被证明检出了具体缺陷，不能把两个阻断算成 2/2 检出。下一步先校准检查预期与基线环境，再考虑扩大编码评测；两轮结果和初始基础设施失败均保留。
