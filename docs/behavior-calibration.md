# Frozen behavior baseline calibration

This diagnostic reuses every frozen check plan from original-image replay run 43571025712. Each exact command runs against two fresh containers: the original effective HEAD and the same fixed candidate patch. It makes no new model calls, does not repair checks and does not produce a new SWE-bench resolution score. Matplotlib, which produced no plan, stays unavailable.

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

只重放上一轮冻结的检查，原始基线和候选分别在断网容器中执行。前后都失败只能说明这条检查没有区分两者，还需检查错误断言、环境问题或未修复缺陷。Matplotlib 没有方案，保留为不可校准。该流程属于诊断工具，不给普通用户任务增加基线阶段，也不会把诊断回执当成产品需求已验收。
