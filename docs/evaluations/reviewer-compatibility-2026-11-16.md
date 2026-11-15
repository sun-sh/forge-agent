# Fixed-candidate compatibility review replay — 2026-11-16

**The intervention did not meet its preregistered efficacy threshold.** One Matplotlib review identified the Nx1 regression; none identified the retained Flask endpoint-exception failure. All six control reviews were accepted, so the overblocking rollback threshold was not triggered. Three duration-budget abstentions are not defect detections.

本轮没有证明漏检已修好：Matplotlib 仅 1/3 命中具体 Nx1 回归，Flask 为 0/3；两个对照均 3/3 放行，另有三次超时弃权。不得把少放行几次、工程测试通过或新状态名称解释为编码质量提升。

[Preregistered interpretation](reviewer-compatibility-protocol-2026-11-15.md) · [registered JSON](reviewer-compatibility-protocol-2026-11-15.json) · [allowlisted aggregate](reviewer-compatibility-2026-11-16.json) · [prior replay](review-upstream-replay-2026-11-14.md)

## Fixed protocol and identities

The protocol label remains 2026-11-15; finalization and execution occurred on November 16 in Asia/Shanghai. Four original planned.r1 patches were each reviewed three times in the registered serial rotated order. No implementation was generated, no candidate was replaced, no new coding ablation ran, no source/test command was executed, and no fresh official grading occurred. Original requests, exact patches, historical native receipts and model-authored ledgers were retained. Official labels, hidden tests, prior decisions and this readout were excluded from reviewer inputs.

The model ID was deepseek/deepseek-v4.1-flash, API openai-completions, thinking medium. The public ID/API match the prior replay, but identical provider/backend revision is not established; this is not a controlled same-service causal estimate. Each fresh Pi reviewer kept the standard limits: 300 seconds, 24 turns, 120 tools, 32,000 output tokens and configured $4. The existing one format retry stayed within that same session and budget; none was used. Parent limits also remained unchanged. Prices are unknown, so configured dollars are not a measured charge or independently enforceable billing cap.

| Identity | Value |
| --- | --- |
| Frozen replay product revision | 5eb85054a9570651cd567dbdce1b7c130804066f |
| Captured source/dist/harness fingerprint | bed366cf55a47fd2952389e3a1e33e0e574ee96f861f5b4289f1a47e9d60da25 |
| Registered Markdown SHA-256 | 737d22986a541e9ca437175b4275b0859c55f64c8025e1f9d57c6c31568b94ab |
| Registered JSON SHA-256 | 7bfb115c6b5b2e58748a93bf58c56f9fc1e9d22bcdd2e182875629745ae2afe9 |
| Prepared protocol content SHA-256 | 92ae6f7aa58bb78bf76e06589ba721ffaea159add064d4d94ee779450579e002 |
| Prepared protocol file SHA-256 | ea7458661d91345d87a4cccce9dd16bd48425bdd04e2dd154451e2b09a9f141c |
| Final raw local report SHA-256 | 779b028df94dfb7b2b99342d11d188fda7985487bafd4fea7b282dbff1734221 |
| Private zero-result admission manifest SHA-256 | 65aa0f1f1907c9d36936931c40c76f89cc96d54e67db450834a6ad3315822973 |
| Model calls started / finished (UTC) | 2026-11-15T16:27:14.493Z / 2026-11-15T16:59:54.817Z |

The admission manifest recorded zero results, the fixed schedule/budgets, model identity, all candidate handoff/workspace/source identities and eight dirty test/fixture paths. Fingerprinted replay bytes were frozen throughout calls and verified unchanged after the final build. Other engineering test/document work continued outside the replay import graph. The aggregate retains original patch, snapshot, report, image, source-tree and handoff hashes, every slot, native reader audit, raw final-text hashes and raw-record hashes. Full sessions, provider aliases, endpoints, credentials and private paths are excluded.

## Results, with every scheduled slot retained

| Candidate | Retained official label | Prior accepted | New accepted | Targeted concrete blocks | Other concrete blocks | Abstained |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Flask | Failed | 3/3 | 1/3 | 0/3 | 0/3 | 2/3 |
| Matplotlib | Failed | 3/3 | 1/3 | 1/3 | 0/3 | 1/3 |
| Astropy | Passed | 2/3 | 3/3 | 0/3 | 0/3 | 0/3 |
| SymPy | Passed | 3/3 | 3/3 | 0/3 | 0/3 | 0/3 |

All 12 candidate workspace checks and reader-path audits passed. The nine returned decisions have complete original acceptance-ID coverage; three timeouts have no final verdict or coverage. Raw, normalized and effective verdicts agree wherever present. The discrimination host guard was not invoked in any slot.

| Slot | Candidate/repetition | Raw / normalized / effective | Coverage | Adjudicated outcome | Turns | Seconds |
| ---: | --- | --- | --- | --- | ---: | ---: |
| 1 | Flask r1 | ready / ready / ready | Complete | accepted | 5 | 160.0 |
| 2 | Matplotlib r1 | — / — / — | No final review | abstained | 9 | 300.0 |
| 3 | Astropy r1 | ready / ready / ready | Complete | accepted | 8 | 93.2 |
| 4 | SymPy r1 | ready / ready / ready | Complete | accepted | 4 | 62.9 |
| 5 | Matplotlib r2 | ready / ready / ready | Complete | accepted | 4 | 202.4 |
| 6 | Astropy r2 | ready / ready / ready | Complete | accepted | 5 | 76.5 |
| 7 | SymPy r2 | ready / ready / ready | Complete | accepted | 2 | 15.4 |
| 8 | Flask r2 | — / — / — | No final review | abstained | 3 | 300.0 |
| 9 | Astropy r3 | ready / ready / ready | Complete | accepted | 3 | 99.0 |
| 10 | SymPy r3 | ready / ready / ready | Complete | accepted | 3 | 26.1 |
| 11 | Flask r3 | — / — / — | No final review | abstained | 3 | 300.0 |
| 12 | Matplotlib r3 | changes_requested / changes_requested / changes_requested | Complete | targeted_changes_requested | 10 | 234.0 |

The three abstentions hit the unchanged 300-second reviewer duration limit (Matplotlib r1: nine turns; Flask r2/r3: three turns each). They remain in each denominator of three. Their missing final verdicts are null, not invented insufficient_evidence judgments. The maximum completed review used ten turns, so this batch provides no evidence for increasing the 24-turn allowance.

## What the findings establish

**Matplotlib r3 is a targeted source finding.** It identifies lib/mpl_toolkits/mplot3d/axes3d.py and the trigger ax.plot(np.arange(3), np.arange(3)[:, None]). Before the new guard, a 1D x/default scalar z is broadcast correctly and base Axes.plot splits the 2D y by column into drawable Line3D objects. The new blanket ndim>1 guard rejects that previously accepted Nx1 case. The review names the prior behavior, new rejection and lack of original-request authorization. This matches the retained Nx1 regression mechanism without receiving the official hidden test. The replay itself does not execute that example or regrade the patch. Its model-authored acceptance items remain met, but the separate concrete compatibility issue blocks ready.

**Matplotlib r2 still misses that boundary.** It asserts that 2D input was not functioning before the patch and returns ready, generalizing the reported broken shape to all 2D shapes. Broad historical passing tests do not establish that claim. The new compatibility instruction therefore does not reliably prevent the original exemption/assumption mechanism. r1 times out rather than finding a defect.

**Flask r1 still excuses unchanged newly failing tests.** Its notes identify test_dotted_names and test_inject_blueprint_url_defaults but treat them as stale assertions of intentionally rejected dotted blueprint names. That does not satisfy the registered B instruction, which also requires the corresponding test path in the supplied patch. Nevertheless the model returns ready. The other two repetitions time out; neither supplies a blocking endpoint finding.

The retained official Flask failure is test_route_decorator_custom_endpoint_with_dots: a dotted route endpoint raises AssertionError where that external test expects ValueError. The original request explicitly asks to reject dotted blueprint names and mentions the pre-existing endpoint check; it does not explicitly demand changing that endpoint exception type. Preserve this requirement-authority ambiguity. A constructor-guard complaint or stale-test-update block would not count as targeted endpoint detection, and none is credited here. The attachment had conflated the stale-test concern with the actual retained official failure.

**Controls remain accepted.** Astropy reviews distinguish the assigned chararray replacement from pre-existing full-disk and zero-precision limitations. SymPy reviews trace permute propagation through syms reordering; they identify the historical repository test runner, and r3 explicitly excludes a zero-test filtered invocation from evidence. These selected controls do not establish a general false-block rate.

## Registered decision and product boundary

Both failing cases needed at least 2/3 targeted concrete blocks while each control retained at least 2/3 acceptance. Flask has zero and Matplotlib one, so efficacy is not established. Both controls have 3/3 acceptance, so the registered at-most-1/3 rollback threshold is not triggered. There are no other concrete blocks, no outcome-driven repeats and no omitted model failures. The instructions remain review policy, not a qualified reliable defect detector; adaptive remains the default workflow.

All four historical snapshots lack task.behavior and baseline calibration. Consequently this batch does not measure C, and no baseline, calibration receipt or host downgrade was synthesized. The separate host constraint recomputes discrimination from valid native receipts and prevents otherwise-valid ready from using all-identical observations as patch-effect proof. It preserves acceptance IDs and does not invent defects. D maps typed missing execution to run_required_tests with zero source-defect count. These engineering changes do not repair the historical misses by relabeling them. src/task/result.ts, resolutionClaimed and result semantics were not changed.

## Separate engineering validation, including failures

The first full active suite had 960 passes and two failures. One was a real regression introduced while merging stop-reason precedence: unresolved inherited-boundary attribution could be presented as code_defects. After all model calls ended, revision 0103a6da2445bafe94b748d80f5626ecd89f2c40 restored the existing evidence priority, retains acceptance IDs, preserves typed missing-execution recovery, and keeps independent concrete findings when calibration is valid. It does not alter the reviewer replay imports, handoffs, budgets or result semantics; the frozen replay bytes were checked unchanged after rebuilding. No new quality measurement is attributed to that later revision.

Post-fix focused regressions pass 389 tests across six files. A separate native Web regression uses actual Pi built-in shell commands: both frozen checks pass before/after with identical command/output hashes, a scripted ready review becomes insufficient_evidence, the implementation is retained and every original acceptance ID becomes unconfirmed. The normal plumbing fixture now also has a real fail-to-pass source assertion plus a stable passing boundary, rather than always-green arithmetic. These are controlled execution-policy fixtures, not real-model quality scores.

The other full-suite failure was the worker false-path parent settling past its existing wait under load. Success and failure apply-and-verify paths both pass an isolated recheck without a timeout change. The isolated Edge run first timed out in MCP connection testing; its same-bound recheck passes the complete browser acceptance script. Both failures and logs are retained locally with hashes in the aggregate. The scripted smoke passes 5/5; final typecheck, build, package assets/CLI and CLI help/version checks pass. The local package check reuses installed dependencies, not a clean dependency installation. Final cross-platform CI is recorded separately by GitHub Actions.

## Limits and next evidence

This is a selected four-patch reviewer diagnostic, not a new SWE-bench resolution score, end-to-end completion-gate qualification or general safety claim. Original Python environments, ignored build products and scratch files were not reconstructed. Matplotlib uses a verified 16 MiB layer prefix plus verified Git objects/tree, not a fully downloaded/verified 971,577,772-byte layer; eight Windows resource symlink placeholders remain. Astropy has an uninitialized astropy_helpers gitlink. Historical receipts are not current-workspace executions. Engineering tests overlapped part of the replay, so timing is not an isolated performance comparison; timeout slots still count.

The next mechanism work is valid native boundary evidence against the original source and candidate, anchored to the original request, rather than further prompt claims or a new three-arm coding ablation. Preserve the failed intervention and source identities; a later change requires a new registered experiment instead of retroactively qualifying these measurements.
