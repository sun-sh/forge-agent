# Production behavior calibration and frozen-check diagnostics

## Production calibration

New Planned Web change tasks with at least one configured `verify` command execute a real pre-implementation baseline. A fresh reader-only Pi designer proposes 2–3 original-request checks; the parent Pi session executes their exact commands with the native built-in shell before product implementation. Baseline and candidate runs use product `pi-builtin-shell` receipts, current Agent-mode/project-trust checks and the shared parent budget. Forge schedules phases above Pi; Pi owns model/tool turns and process execution. This adds no configuration keys or CLI task orchestration. Adaptive/Direct, read-only, pure verification and unconfigured-check paths retain their scope; legacy records do not acquire a retrospective baseline claim. Continuing a legacy task that already entered implementation cannot introduce a new design or baseline on its current files.

A baseline is **observed**, rather than required to pass: it needs all exact native receipts, usable exit/output evidence and an unchanged observable workspace. An expected reproduction failure can therefore be a valid pre-fix observation. A failed non-reproduction check (boundary/regression), or an incomplete baseline, admits at most one fresh reader-only diagnosis. It sees the original request, plan and baseline evidence, reads the owning API/source contract, and returns `keep`, `replace` or `unavailable`, with one finding per original check. Finding kinds are `expected_failure`, `valid_check`, `invalid_expectation`, `environment` and `unconfirmed`. The diagnosis prompt explicitly uses `valid_check` for a passing, contract-supported boundary/regression check; uncertain semantics remain `unconfirmed` and blocking. A supported passing check need not be mislabeled as unknown merely because the reproduction fails; a nonzero exit alone establishes none of them. A legitimate requested bug stays an expected failure rather than being weakened into a passing baseline.

### Correction admission

Only a complete ready replacement can change a command or expectation. The host requires the same check count and ordered IDs, the same kinds, shells and exact original-request anchors, and no larger timeout per check. Each adopted command/expectation change needs an `invalid_expectation` or `environment` finding with a project source path and exact contract quotation. The host validates the project path, bounded ordinary-file contents and quote presence (allowing CRLF/LF normalization), rejects sensitive evidence, and retains source/quote hashes. An unsupported environment is not permission to install dependencies, change product/tests/configuration, mask failure or redefine the request.

For checks explicitly retained as expected_failure or valid_check with an identical command, the host always keeps the original frozen expectation, regardless of proposed rephrasing. It records proposed/retained wording in correction.preservedExpectations; the original model response remains in the child record. This does not infer semantic equivalence or adopt relaxed wording. Changed commands and other expectation changes still require the same source-backed diagnosis and all original coverage/permission bounds. No extra diagnosis or model retry is added.

Quote presence proves that cited text exists, **not its relevance or the correctness of the replacement expectation**; that judgment remains fallible model work. A matching request quote likewise establishes an anchor, not full coverage. Frozen-command and tool restrictions do not make shell an OS sandbox: commands retain launching-user permissions. Use a container, VM or restricted account for untrusted projects.

Durable `task.behavior.calibration.runs` retains original plan snapshots, run IDs, receipts and before/after workspace stamps. Correction metadata retains the diagnosis and admitted source evidence. A replacement is re-executed on the pre-implementation workspace **before implementation begins**, and its own receipts must establish the baseline for that replacement plan. Earlier failures remain preserved. The four-entry admission bound includes the original run, a replacement run and interrupted/recovery runs; it is not four additional retries.

### Recovery and candidate evidence

Before implementation, explicit continuation can resume baseline collection only while the first admitted workspace digest and scope still match. Restart/continuation preserves admissions and the one diagnosis opportunity. An interrupted baseline becomes unconfirmed; an interrupted diagnosis becomes unavailable and remains consumed. A changed/unobservable workspace or four consumed admissions requires inspecting current files and starting a new task instead of rebasing the saved comparison. There is no automatic unbounded baseline retry.

The implementation-start marker and entry into the `implement` phase are persisted atomically in one task-state transition before implementation tools run. Accepted correction metadata and its replacement plan likewise commit together, so recovery cannot observe only half of either transition. This atomicity concerns a task-state snapshot, not a transaction across Pi logs, task indexes or workspace side effects.

Once `implementationStarted` is set, repairs and continuation reuse the frozen checks and retained baseline. They may obtain fresh candidate receipts and configured verification, but never redesign checks or build a baseline from implemented files. Missing/unavailable design, an invalid baseline or an unresolved diagnosis remains blocking even if candidate commands and configured verification pass and the static reviewer says `ready`. Evidence collection alone does not repair these gaps.

Candidate comparisons require the same complete pre-run and settled candidate workspace stamps, with a settled execution timestamp; mutation or incomplete stamps produce unconfirmed comparisons even when individual commands return zero. Older calibrated records without a candidate pre-run stamp cannot acquire that attestation without a fresh candidate run. Candidate comparisons use `changed_to_pass`, `unchanged_pass`, `pre_existing_failure`, `candidate_regression` or `unconfirmed` (the observation table below explains the pass/fail combinations). They are observations, not concrete code-defect proof: even a new failure needs contract/output/environment inspection. Unexplained inherited failures and incomplete attribution request evidence rather than automatically driving a code-repair loop. `sameOutput` compares output hashes, not semantic equivalence. Passing these model-proposed checks still leaves `acceptance=unverified` and `resolutionClaimed=false`. See [result fields](task-results.md#behavioral-receipt-gate) and [execution limits](behavior-checks.md).

### Evidence boundary

This describes the new production lifecycle, not a measured model-quality result. Historical reports below remain immutable under their original protocols and code fingerprints; their execution/test/model numbers do not certify this implementation. New engineering and model runs need a separate fingerprinted evidence report, retaining failures. No new test counts, model outcomes or quality gains are claimed here.

## Historical frozen-check diagnostic

The separate historical diagnostic reuses every frozen check plan from original-image replay run 43571025712. Each exact command runs against two fresh containers: the original effective HEAD and the same fixed candidate patch. It makes no new model calls, does not repair checks and does not produce a new SWE-bench resolution score. Matplotlib, which produced no plan, stays unavailable. This offline worker is distinct from the production parent-session lifecycle above.

## Identity and execution

`evals/swebench-lite/behavior-calibration.json` pins source-report and check-plan SHA-256 values. Original image, patch, snapshot and grading provenance are still admitted by `behavior-replay-protocol.mjs`; historical labels stay outside the worker. Calibration requires exact request/plan provenance, native command hashes, complete receipts and an unchanged tracked workspace.

The worker calls Pi 1.4.0 built-in shell implementation programmatically, with no AgentSession, model runtime, credential files or Provider requests. Receipts use `pi-programmatic-shell`, distinct from product-session `pi-builtin-shell` receipts. This measures frozen commands, not a fresh designer or the full product lifecycle.

Each target uses a separate fresh container with network disabled, no host mounts/sockets, dropped capabilities, no-new-privileges, two CPUs, 6 GiB and 512 processes. Frozen command timeouts remain unchanged; each control has an eight-minute outer bound. Image/package preparation requires network before the offline controls start. No project extension or Provider configuration is loaded.

## Interpret the comparison

| Baseline | Candidate | Observation | Limit |
| --- | --- | --- | --- |
| Failed | Passed | changed_to_pass | Does not prove complete acceptance |
| Passed | Passed | unchanged_pass | Does not establish defect sensitivity |
| Failed | Failed | pre_existing_failure | Could be a bad expectation, environment or unfixed bug |
| Passed | Failed | candidate_regression | Still requires inspecting failure/environment before claiming a code defect |
| Incomplete | Any | unconfirmed | No useful pass/fail attribution |

A failed baseline assertion is never automatically labeled an environment error or a code defect. A reproduction commonly fails before a fix, while an existing valid-input boundary should remain usable. Check kinds are model-authored labels, not proof. Every comparison retains concreteDefectClaimed=false. Changed plans/commands, duplicate/missing receipts and workspace mutation invalidate attribution. Workflow success means that the diagnostic completed, not that candidates or checks are correct.

## Run

The behavior-baseline-calibration workflow on codex/behavior-calibration downloads pinned artifacts and runs at most two cases concurrently. The GitHub token is used only to download artifacts. There are no Provider Secrets or model preflight, and the model replay workflow does not trigger on this branch.

Local admission without Docker or model calls:

```sh
npm run build
node scripts/swebench-behavior-replay.mjs --case pallets__flask-4045 --source-run ORIGINAL_RUN_ROOT --graded-run REGRADED_RUN_ROOT --calibrate-from FROZEN_DESIGN_ARTIFACT --output NEW_DIRECTORY --prepare-only
```

On a Linux Docker host omit --prepare-only and supply --package with the freshly packed Forge tarball. Evidence retains image/package/harness/command identities, both controls, missing plans and all failures. Public reports require allowlisting/redaction; no private paths, endpoints or credential stores. The [first inspected execution report](evaluations/behavior-calibration-2026-11-15.md) retains all four outcomes, including the missing plan. It does not qualify the historical misses.

## 中文

上文生产路径面向新建且配置验证的 Planned Web 变更任务：父 Pi 会话先实际运行基线；预期复现失败可以是有效观测，边界失败或回执不完整至多进行一次全新只读诊断；通过且有契约支持的边界/回归检查标为 `valid_check`，语义仍不明则保持 `unconfirmed`。实现开始标记与阶段、采纳更正与替换方案分别在同一任务状态中原子提交；已进入实现的历史任务继续时不能新造设计或基线。仅采纳源码原文核对通过、保留覆盖与权限边界且不增大超时的更正，保留原方案/回执，并先重跑基线再实现。实现前明确继续须匹配同一工作区，累计最多四次基线准入；实现后不重设计或补造基线，无效证据仍阻断静态 ready。源码引文存在不等于相关性已证明；shell 不是 OS 沙箱，比较也不是具体缺陷证明。自适应、只读、未配置验证和 CLI 原有职责不变，无新配置键。

这里另列的历史诊断只重放上一轮冻结检查，基线和候选分别在断网容器中执行，不调用模型、不更正检查。前后都失败仍需区分错误断言、环境问题或未修复缺陷；Matplotlib 无方案，保留不可校准。旧报告及数字不可改写为新生产代码的验证，新运行须另存带代码身份的证据；两条路径都不声称需求已验收。

## Production qualification evidence

The [controlled real-model qualification](evaluations/behavior-production-2026-11-15.md) retains both protocols, the first false block, the corrected run and their exact code fingerprints. It is not autonomous coding quality or a SWE-bench result.
