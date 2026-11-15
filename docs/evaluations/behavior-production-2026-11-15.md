# Production behavior calibration qualification — 2026-11-15

This is a controlled production-lifecycle qualification, not autonomous coding quality, SWE-bench resolution, or proof that calibration improves general quality. Inspection and candidate implementation are scripted. Check design, parent Pi command execution, fresh baseline diagnosis and independent final review use the configured real DeepSeek model. Pi 1.4.0 remains the model/tool runtime.

## Protocol and identity

The [driver](../../scripts/probe-production-behavior-calibration.mjs) creates a tiny CommonJS fixture: normalizePoints rejects Nx1 columns; the request requires flattening, preserved flat/empty inputs, new arrays and no input mutation. Existing tests and package scripts are protected. Configured verification is syntax-only, intentionally insufficient for the reported behavior.

Within each run, correct and defective candidates share one frozen real independent check plan. The correct candidate flattens columns; the defective candidate only changes the thrown error. A separate case injects an explicitly wrong empty-array identity expectation, then requires a fresh real diagnosis, actual source-quote validation and pre-implementation re-execution. The host retains both plans and native receipts. Each product decision is flushed before a separate external assertion oracle runs. No oracle results or candidate labels enter model context.

Model: deepseek/deepseek-v4.1-flash, OpenAI-compatible completions, medium thinking. One attempt per case per protocol. Prices are not configured: monetary cost is unknown, not zero. Protocol hashes, exact built-code/driver fingerprints, native command hashes/exits, workspace digests, token counts and all six case outcomes are in the [allowlisted evidence](behavior-production-2026-11-15.json). Raw private sessions, credentials and provider endpoints are excluded.

Corrected runtime source is commit 9eabebd. That source tree was committed during run 2 without changing measured bytes. Fingerprints, rather than the commit time, identify executed code. Run 1 used the earlier uncommitted implementation and does not qualify later fixes.

## Retained first run

Protocol: production-behavior-calibration-fixed-candidates-v1

Built code/driver fingerprint:

    563456715ac243633c1c987d8461322faaf3f378956b4ad5eeabb0e222868b72

| Candidate | Product result | External oracle | Harness qualification |
| --- | --- | --- | --- |
| Correct | blocked | pass | fail |
| Still defective | blocked | fail | fail |
| Wrong-check correction | implemented_unverified | pass | pass |

The first correct candidate exposed a real false block: every candidate command passed, but the diagnosis taxonomy had no clear category for a valid passing regression check. The model retained it as unconfirmed, and the host correctly refused to turn that uncertainty into a pass. Added valid_check distinguishes an observed, supported passing check from an expected pre-fix failure and unresolved semantics. Host validation also requires its native baseline receipt to have passed.

The v1 harness additionally prohibited any diagnosis in the paired controls, even a normal keep diagnosis preserving every frozen command. That restriction did not match the production protocol when a legitimate boundary reproduced the same bug. V2 permits one keep diagnosis while still forbidding plan replacement in the paired comparison. Source-backed replacement remains mandatory in its separate control. This protocol change is disclosed; the old result is not relabeled. V1 also overwrote failing assertion names with AssertionError; original indexes/messages remain, and v2 preserves names.

## Second run

Protocol: production-behavior-calibration-fixed-candidates-v2

Built code/driver fingerprint:

    860edb1fde4763ab0901a58fa8b94bb0bccb77102546607d239b839ef2f113e0

| Candidate | Product result | External oracle | Harness qualification |
| --- | --- | --- | --- |
| Correct | implemented_unverified | pass | pass |
| Still defective | blocked | fail | pass: correctly rejected |
| Wrong-check correction | implemented_unverified | pass | pass |

The real diagnosis used valid_check for an already passing boundary and retained the requested failures. In the correction control, the original invalid assertion failed, the replacement baseline passed that assertion, and the requested reproduction still failed before implementation. Both baseline versions and their source evidence remained durable. Corrected candidate checks then passed. Protection stayed unchanged. All decisions kept resolutionClaimed=false.

Both runs used native parent-session pi-builtin-shell receipts. Temporary credential/session homes were removed, and driver checks confirmed measured code stayed unchanged during each run. A qualification pass is not an assertion that every candidate should pass: rejection of the defective candidate is the required negative-control outcome.

## Limits and next evidence

The second run used a fresh designer and changed some checks; protocol and recovery code also changed. It is not an isolated causal experiment for valid_check, nor a measured quality gain. Source quotation presence cannot prove semantic relevance, and passing model-authored commands cannot certify all requirements. These samples do not resolve the historical Flask/Matplotlib misses or replace a real-repository ablation.

Recovery regressions additionally cover legacy postimplementation provenance, atomic implementation marker/phase and replacement-plan transitions, and interrupted replacement-baseline recovery. Engineering checks and their failures belong in a separate engineering record; mock/API tests are not real-model quality evidence.

下一步应固定真实仓库、原始请求、环境和候选补丁，检验校准能否减少错误检查造成的阻断，同时保留缺陷检测能力；本报告不声称已经证明这一点。
