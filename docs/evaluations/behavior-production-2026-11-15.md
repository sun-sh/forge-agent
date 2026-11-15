# Production behavior calibration qualification — 2026-11-15

This is controlled production-lifecycle qualification, not autonomous coding quality, SWE-bench resolution or proof of general quality improvement. Inspection and candidate implementation are scripted. Independent check design, parent Pi shell execution, fresh diagnosis and final review use the configured external model service. Pi 1.4.0 remains the model/tool runtime.

## Protocol

The [driver](../../scripts/probe-production-behavior-calibration.mjs) creates a tiny CommonJS fixture where normalizePoints rejects Nx1 columns. The request requires flattening, preserved flat/empty inputs, new arrays and no mutation. Existing tests and package scripts are protected. Configured verification is syntax-only and intentionally insufficient.

Within each run, correct and defective fixed candidates share one frozen real independent plan. A separate control injects an incorrect empty-array identity expectation and requires a fresh real diagnosis, actual source-quote validation and pre-implementation rerun. Product decisions are flushed before a separate external oracle. No oracle outcomes or candidate labels enter model context.

Configured model ID: deepseek/deepseek-v4.1-flash, OpenAI-compatible completions, medium thinking. The backend vendor identity is not independently attested. One attempt per case per recorded run/code fingerprint. Prices are unconfigured: monetary cost is unknown, not zero. [Allowlisted evidence](behavior-production-2026-11-15.json) retains all 15 case attempts, native command hashes/exits, workspace digests, token counts and source identities; no raw private sessions, credentials or endpoints are published.

## Retained outcomes

I = implemented_unverified; B = blocked. The defective control is supposed to be blocked. Oracle outcomes for correct / defective / correction candidates are pass / fail / pass in every run. No result claims resolution.

| Run | Runtime source | Protocol | Correct | Defective | Wrong-check correction | Qualification |
| --- | --- | --- | --- | --- | --- | --- |
| r1 | uncommitted earlier code | v1 | B | B | I | failed |
| r2 | 9eabebd | v2 | I | B | I | passed |
| r3 | 193fdab | v3 | I | B | B | failed |
| r4 | bc7e009 | v3 | B | B | I | failed |
| r5 | 43c5a1c | v3 | I | B | I | passed |

## Exact fingerprints

Protocol hashes and full per-case identities are in the JSON. Built-code/driver fingerprints:

- r1: 563456715ac243633c1c987d8461322faaf3f378956b4ad5eeabb0e222868b72
- r2: 860edb1fde4763ab0901a58fa8b94bb0bccb77102546607d239b839ef2f113e0
- r3: c6941085559983f98aa4301d721dd95cfbeb2fc286a3123a44a8d06cf99c110f
- r4: 4daf8bd04417ad533c7a8f897f88f9c4d32609d87d507ab6a0293ca240218e3d
- r5: 55a49f15a2a1c534c60ffc9389ee996ad9637a55066f0fea016632388b33e12b

Only r5 measures runtime commit 43c5a1ca98f01ce54a96c92228f19fc99bd1f08b. Earlier successes and failures remain tied to their earlier code. The r2 source tree was committed during that run without changing measured bytes; other recorded committed runs identify their source before execution.

## What the failures established

- r1 exposed a real false block: all candidate commands passed, but there was no clear finding category for a supported passing check. Added valid_check, tied to a native baseline pass; unresolved semantics remain blocking.
- Protocol v1 incorrectly prohibited a legitimate keep diagnosis in the paired controls. V2 permits one keep while preserving the identical frozen plan; replacement is still prohibited in that pair and required in its separate correction control. This protocol change is disclosed rather than relabeling v1.
- r3 added explicit candidate pre-run/settled stamp checks. Correct and defective controls qualified, but the correction model rephrased an unchanged B1 expectation without a source-backed finding. The strict validator rejected the whole proposal, leaving a wrong B2 check and blocking a correct candidate.
- The subsequent host fix preserves the original frozen expectation for explicitly retained checks whose command is identical. Proposed/retained wording is audited; changed commands and other adopted expectation changes still need source evidence. The original child response remains retained. R4 correction passed but had zero preservation events, so that pass cannot be attributed to the new branch; deterministic regressions cover it.
- r4 exposed another false block: diagnosis JSON included command/expectation inside findings and remained invalid after its one generic format retry. Added concrete schema paths/errors to that same existing retry, without stripping unknown fields, reopening tools, increasing budgets or adding model calls.

## Final recorded control

R5 qualified all three controls: the correct candidate was delivered as implemented/unverified; the defective candidate stayed blocked; the wrong-check control retained original failures, admitted a source-backed replacement and reran it before implementation. Candidate workspace stamps were stable, protected inputs unchanged, and every decision retained resolutionClaimed=false.

- correct: diagnosis format retries [1]; preserved expectation events 0.
- defective: diagnosis format retries [1]; preserved expectation events 0.
- controlled-correction: diagnosis format retries [1]; preserved expectation events 0.

Temporary credential/session homes were removed and code-stability checks passed in every run. These are single tiny controls with fresh model outputs and evolving code/protocols, not an isolated ablation. Neither a final pass nor five blocked defective controls proves general defect sensitivity, reduced false completion or reduced cost. Source-quote presence still does not prove semantic relevance.

## Engineering evidence

The [engineering record](behavior-production-engineering-2026-11-15.json) retains local failures, bounded test fixes, focused regressions and the completed browser check. CI results belong to the exact commit in each GitHub run; earlier green jobs are not relabeled as validation of later code. Scripted API/browser tests do not become model-quality measurements.

Next qualification should pin real repositories, original requests, environments and fixed candidates, then measure whether calibration reduces invalid-check blocks without losing defect rejection. Historical Flask/Matplotlib misses and earlier SWE-bench results remain unresolved evidence questions.
