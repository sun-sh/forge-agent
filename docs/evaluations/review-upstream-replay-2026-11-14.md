# Retained upstream patch review replay — 2026-11-14

**The current reviewer accepted all six reviews of the two officially failing candidates. No concrete defect was blocked.** The two officially passing candidates received five accepts and one time-budget abstention. These results do not qualify the missed behavior, prove general reviewer safety, or support expanding a new end-to-end reviewer comparison yet.

The [allowlisted aggregate](review-upstream-replay-2026-11-14.json) retains all 12 decisions, exact original patch identities, source trees, handoff hashes, command summaries, reviewer findings and failed preparation attempts. No product source, reviewer policy or budget was changed for this measurement.

## Frozen protocol

Four original Planned candidates are selected deterministically: repetition 1 from `pallets__flask-4045`, `matplotlib__matplotlib-23563`, `astropy__astropy-6938` and `sympy__sympy-18189`. The first two were delivered with a ready review but failed official grading; the latter two passed official grading without completing Forge delivery. They come from original run `43184349339`, with separate retained-patch official regrading in `43196437456`. This is a deliberately selected diagnostic, not a representative cohort or 12 independent coding tasks.

Each unchanged candidate receives three independent fresh Pi reviews through the current `ForgeSubagents.reviewGate`, current complete-patch handoff and original native command receipts. Case order rotates its starting position between repetitions. No implementation is regenerated, no repair is allowed, no official tests are applied or executed, and no labels or old reviewer findings are included in the handoff. The original user request and original model-authored requirement ledger are both retained; the latter does not gain user authority.

Original configured syntax-check outputs are supplied as historical observations with freshness `unconfirmed`. This source-only Windows replay does not rerun those checks or recreate the original Python environments/ad hoc scripts. It measures reviewer judgments, **not a fresh host completion gate or new official SWE-bench resolution rate**. An accepted model decision cannot override the absence of current verification.

A well-formed ready verdict requires exact acceptance-ID coverage, all items met and no issues. A concrete `changes_requested` finding is a defect block. Insufficient evidence, incomplete/inconsistent acceptance, format failures and budget exhaustion are abstentions, rather than successful defect detections. All categories remain in the denominator. Source changes or reader paths outside the candidate invalidate a sample. Child transcripts and before/after workspace fingerprints are retained locally for that audit.

## Source reconstruction and isolation

The original image's effective HEAD differs from the dataset base commit. Merely cloning the dataset base would therefore replay a different candidate. The adapter checks the registry manifest's config ID against the retained image ID, reads its task-layer Git objects, validates ancestry/object hashes, reconstructs the original tracked tree, and requires the rendered candidate diff to match the original patch SHA-256 byte for byte. The reviewer sees a fresh snapshot commit containing only that tree, with no upstream history, hidden-test patch or grading files.

For the large Matplotlib layer, only a bounded 16 MiB prefix is downloaded. The fixed public base commit is shallow-fetched; verified image loose objects supply its setup commit. The complete 971,577,772-byte layer is **not** downloaded/verified. Git objects, final source tree and exact patch are independently checked and the partial-source transport hash is retained. This distinction is explicit in the aggregate.

Eight Matplotlib resource symlinks keep their original Git modes and target bytes using Windows Git placeholders. Astropy's `astropy_helpers` gitlink is retained but uninitialized. These are source-inspection limits, not claims that those dependencies are runnable. Reviewer tools are audited for dependence on these paths. Other ignored/generated artifacts and temporary implementation scratch scripts are absent; their original outputs, where retained by the bounded receipt handoff, remain historical evidence.

Candidates live in task-owned temporary directories outside Forge's checkout, so the reviewer does not inherit Forge's `AGENTS.md`. The actual product's restricted read-only tools (`read`, `grep`, `find`, `ls`), disabled extensions/packages/MCP/delegation, and standard budget apply. These restrictions are tool policy, not an OS sandbox. This experiment does not execute untrusted repository code. Temporary authentication homes are deleted on exit; no endpoint or credential value is published.

## Results

| Frozen candidate | Retained official result | Accepted now | Defect blocks | Abstentions |
| --- | --- | ---: | ---: | ---: |
| pallets__flask-4045 | Failed | 3/3 | 0/3 | 0/3 |
| matplotlib__matplotlib-23563 | Failed | 3/3 | 0/3 | 0/3 |
| astropy__astropy-6938 | Passed | 2/3 | 0/3 | 1/3 |
| sympy__sympy-18189 | Passed | 3/3 | 0/3 | 0/3 |

All **6/6 reviews of officially failing candidates were accepted**, with 0 concrete blocks. Officially passing candidates received 5/6 accepts, 0 concrete blocks and 1/6 abstentions. Astropy repetition 2 hit the 300-second child duration limit after six turns and returned no valid verdict. It is not counted as a defect detection or a completed erroneous judgment.

Maximum turns: **10**, below the 24-turn ceiling. Total recorded request tokens including cache: **1,043,200**; output tokens: **82,577**; charged reader calls: **87**; sum of per-review elapsed times: **23.35 minutes**. Recorded usage is not a bill, and an aborted request may lack complete usage. Dollar cost is unknown. All 12 workspace fingerprints stayed unchanged; all charged tool calls are present in the retained transcripts and stayed within the corresponding candidate root.

## What the decisions establish

The current reviewer still lets both historical failure mechanisms through on all repetitions. This is direct evidence of current acceptance of these exact officially failing patches, not a measured repair of their misses. The earlier synthetic counterexamples did not predict success on these upstream candidates.

For Flask, the reviews accept the new constructor guard and treat existing dotted-name test failures as intended or pre-existing. They do not require changing the unchanged endpoint exception contract. The official failure below concerns that additional expectation, so it must be distinguished from simply failing to notice that tests were run or that their outputs contained errors.

For Matplotlib, one review explicitly notices that the new guard narrows column-shaped input and then downgrades it to an optional note because of the 1D docstring/model-authored contract. All three approve rejecting nested/2D inputs. The preserved implementation ledger itself defines raising ValueError on 2D input as acceptance; the current original-request/counterexample instruction did not reliably dislodge that interpretation. The original behavior problem is therefore still not established by reviewing the implemented plan and a green old suite.

Five accepts on the two officially passing patches show that those current sessions can use the bounded native receipts without reproducing the previous observed blocks. One correct patch still obtains no decision within the time limit. This is not a causal improvement estimate: model/service setup, handoff and source-only environment differ from the historical runs.

There is no new evidence here that a larger turn allowance would detect either missed behavior: all six failed-candidate accepts finish within ten turns. The one time-limit failure is real but does not validate a 40-turn default. The useful next intervention is independently executable checks derived from the original trigger and boundary behavior, with ambiguous expectations and missing evidence kept explicit. Another 45-run coding comparison would add implementation sampling noise before this reviewer mechanism is qualified.

The earlier single missing-tests probe remains separate: it established a block only when the original user explicitly required a test execution that never occurred. It did not establish detection of wrong behavior after tests ran. Here the original Flask receipts include actual failing test runs; Matplotlib's existing module reported 136 passed while the official Nx1 acceptance still failed. No new prompt or fix receives credit for these historical test executions.

The historical official Flask failure is `test_route_decorator_custom_endpoint_with_dots`: a dotted route endpoint still raises `AssertionError` where the official test expects `ValueError`. Its original issue text primarily asks for the blueprint-name check and does not explicitly state that endpoint exception-type expectation. That under-specification is a limit on interpreting this sample as a universally discoverable product defect. The Matplotlib failure is `test_draw_single_lines_from_Nx1`: rejecting all two-dimensional arrays also rejects the official Nx1 case. These diagnoses come from retained official output read by the experimenter, never supplied to reviewers. A correct official label is not a claim of universal code correctness, and a blocking finding still needs scrutiny for relevance.

## Identity, cost and preparation failures

- Product revision: `48a808e2bfb2bc7b22b74d7c08f8f396a9215c7f`; product sources were unchanged.
- Captured harness/source/dist fingerprint: `e4ace975e3468f014f11593d6a56bf8c1b5ce261ef0ece5083f64ef9e2b349d3`.
- Frozen protocol-content fingerprint: `9619e7c40eccb0b6f336127b2ca1ede90346de410bd0fabaac2f84de53ece7c8`.
- Full protocol-file SHA-256: `da12b7c6314fbfb2a2e5abf07ea07cc44bfd40d6a2c2530357f308912243c715`.
- Raw completed local report SHA-256: `09a2610f8fa83d2782ed596f40204adb9d3d7e84c7f9644442a8641a4eadb52e`.
- Each candidate's effective HEAD, complete source tree, patch/snapshot/official-report/handoff hashes, image config and source-layer descriptors are retained in the aggregate.
- Publication redacts local paths and environment paths already present in the public issue. It does not change the actual reviewer inputs; raw handoff hashes bind the original text.

The current configured model is `deepseek/deepseek-v4.1-flash`, `openai-completions`, medium effort. Its service/model configuration is not claimed identical to the historical official `deepseek-flash` runs. This is current-behavior evidence on fixed patches, not a causal before/after prompt ablation with identical models. Catalog pricing is unavailable; dollar cost remains unknown.

Standard reviewer limits are 5 minutes, 24 turns, 120 tool calls, 32,000 output tokens and a configured $4 limit per session. Unknown catalog pricing prevents treating dollar limits as an independently enforced billing cap. Each reviewer also shares a fresh parent ledger with the recorded parent limits. No extended-budget setting is enabled. Tokens include cache reads and therefore are request totals, not unique context size or a dollar bill.

Six preparation attempts failed **before any new model review**: Git object abbreviation width; a full Matplotlib layer download timeout; two Windows alternate-object-path diagnostics culminating in a CRLF fix; unsupported resource symlinks; and an uninitialized Astropy gitlink. Their original reports and harness fingerprints remain separate. The seventh preparation froze all four candidates before any model call. These failures are infrastructure history, not omitted model failures.

Build and the 33 existing handoff/evidence/review-reason regressions passed. The initial sandboxed Vitest startup was refused at `esbuild` subprocess creation (`spawn EPERM`); the actual tests passed when local child processes were allowed. There was no product change requiring a claimed new full-suite/remote-CI result.

## Reproduction

From the repository root after building, with retained local original/regraded artifact directories and an already configured Pi model:

```sh
npm run build
node scripts/replay-swebench-review.mjs --model YOUR_PROVIDER/YOUR_MODEL --source-run ORIGINAL_RUN_ROOT --graded-run REGRADED_RUN_ROOT --output .forge-agent/NEW_REPLAY_DIRECTORY --prepare-only
node scripts/replay-swebench-review.mjs --model YOUR_PROVIDER/YOUR_MODEL --source-run ORIGINAL_RUN_ROOT --graded-run REGRADED_RUN_ROOT --output .forge-agent/NEW_REPLAY_DIRECTORY --run-prepared
```

Python and Git are required for source-only reconstruction; Docker is not required for this reviewer diagnostic. Preparation fails on source/patch/label identity mismatches, and the run step refuses changed harness bytes or previously recorded decisions. Preserve the task-owned temporary candidate directories between those two commands. This command is not a substitute for official Linux/Docker end-to-end evaluation.

## 中文结论

四份真实旧补丁各独立审阅三次，共 12 次。Flask、Matplotlib 的原补丁都未通过官方判题，本次各 3/3 被 reviewer 放行；Astropy、SymPy 的原补丁官方通过，本次分别获准 2/3、3/3，Astropy 另一次在 6 回合时触及 5 分钟时限，没有有效结论。明确缺陷阻断为 0。它说明当前审阅仍放过这些官方失败候选，不能把此前简单模拟反例的成功说成真实漏检已修好。

本次固定实际源码树与逐字补丁，补回原生测试回执，官方结果不进入 reviewer。没有生成新实现、修改产品策略、扩大预算或执行新的官方判题；它是审阅组件诊断，不是新 SWE-bench 得分。模型服务与旧评测也不宣称相同。预算弃权、六次零模型调用的准备失败和已脱敏的公开汇总全部保留。下一步应围绕原始触发条件与边界行为建立可执行验证，再决定是否值得进行新的大批量对照。
