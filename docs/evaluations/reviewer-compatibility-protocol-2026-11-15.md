# Reviewer compatibility replay preregistration — 2026-11-15

**Status: preregistered; no new model reviews, build, implementation generation or official grading performed for this protocol.** This freezes the selection, order, limits and interpretation before the parent's final build and subsequent replay. The [machine-readable protocol](reviewer-compatibility-protocol-2026-11-15.json) is an experimenter-side specification, not a reviewer prompt or a new input format for the replay driver.

The requested file/protocol label remains `2026-11-15`. Finalization occurred on **November 16, 2026, Asia/Shanghai** after local midnight; this is not a backdated execution record.

## Scope and comparison

Use the existing `scripts/replay-swebench-review.mjs` with the same four frozen candidates and three independent fresh reviews each. Preserve the exact 12-position schedule from the [prior upstream replay report](review-upstream-replay-2026-11-14.md) and [aggregate](review-upstream-replay-2026-11-14.json). This is a reviewer-only diagnostic on selected historical patches, not a new implementation sample, three-arm ablation, SWE-bench resolution score or completion-gate qualification.

This preparation changes evaluation documents and the replay driver's fingerprint/observation metadata only. It does not implement the attachment's proposed product changes, alter task/result semantics, relax a gate, increase reviewer limits, add behavioral checks, or execute repository/test code. Pi remains authoritative for the reviewer session and model/tool turns; Forge supplies its existing handoff and restricted reader policy.

The preregistration checkout was `master` at `4ddffe771e48aba4f3dfa83e5ca9b0c34756baad`. This identifies the inspected code, **not** the unbuilt future intervention. The parent must record the final execution revision, working-tree differences and captured source/dist fingerprint after the final build. Freeze that artifact set before model calls; do not attribute old measurements to the new bytes. Any later change to selection, order, limits, model identity or interpretation requires a separately dated amendment before calls, retaining this version.

## Immutable historical evidence

The source artifact is `swebench-real-evidence-43184349339` from original Planned run `43184349339`. Its report SHA-256 is `a1792a3e12313809fd574f62f0539f67f71cd82ee4ddea5f99ba7aaf35070bff`. The separate retained-patch artifact is `swebench-regrade-evidence-43196437456` from official regrade `43196437456`, report SHA-256 `26f74f0deb4ef4de37ceeff8e88c0aadce1801bed6afab1b6e6a94ccc293dd97`.

The prior completed replay has raw-report SHA-256 `09a2610f8fa83d2782ed596f40204adb9d3d7e84c7f9644442a8641a4eadb52e`, protocol-content SHA-256 `9619e7c40eccb0b6f336127b2ca1ede90346de410bd0fabaac2f84de53ece7c8`, protocol-file SHA-256 `da12b7c6314fbfb2a2e5abf07ea07cc44bfd40d6a2c2530357f308912243c715`, and captured harness/source/dist fingerprint `e4ace975e3468f014f11593d6a56bf8c1b5ce261ef0ece5083f64ef9e2b349d3`. Its product revision is `48a808e2bfb2bc7b22b74d7c08f8f396a9215c7f`. These remain historical identities.

Preparation inspection verified these report/protocol hashes, all four original patch and snapshot hashes, and all four retained official-report hashes and resolved labels. It did not dump implementation/reviewer sessions or inspect credentials. All six earlier zero-review preparation failures remain retained with their original hashes in the prior aggregate; they are not successful samples or omitted model failures.

| Fixed candidate, always original `planned.r1` | Historical official label | Prior accepted / 3 | Prior abstained / 3 | Patch SHA-256 |
| --- | --- | ---: | ---: | --- |
| `pallets__flask-4045` | Failed | 3 | 0 | `770690aee527cfcd6752d1ddc9d66866709be021b54e4dcc49f8affa1b859191` |
| `matplotlib__matplotlib-23563` | Failed | 3 | 0 | `4ca8be6d8883e43dc0de1b03fb0c04693267689874425d756b645c0077431cd7` |
| `astropy__astropy-6938` | Passed | 2 | 1 | `f580d0ca660630f9a048e6dcf975f1d6d370a85fb2a9ea2defc0e7e8dc16e2e9` |
| `sympy__sympy-18189` | Passed | 3 | 0 | `10189ce6e8dfae864b295a89204755ba2bf71fa42ac4224230d45ebc012708a8` |

The prior replay had zero concrete defect blocks. Astropy's missing decision was a 300-second timeout after six turns. Preserve that abstention; do not turn it into an acceptance, defect detection or completed false block. The historical official pass labels qualify these particular controls, not universal correctness. Do not relabel original `completed`, review or official fields.

## Fixed schedule and unchanged limits

Each slot starts a fresh reviewer session, serially. `run` means reviewer repetition, not a different source patch.

| Repetition | Position 1 | Position 2 | Position 3 | Position 4 |
| --- | --- | --- | --- | --- |
| 1 | Flask | Matplotlib | Astropy | SymPy |
| 2 | Matplotlib | Astropy | SymPy | Flask |
| 3 | Astropy | SymPy | Flask | Matplotlib |

Use thinking `medium` and review profile `standard`: 300,000 ms, 24 model turns, 120 tool calls, 32,000 output tokens and configured $4 per reviewer. Keep the existing one format-correction retry in the same session and budget; do not add judgment retries, reseed, replace abstentions or increase limits. Each review keeps the existing fresh parent ledger: 5,400,000 ms, 240 turns, 500 tool calls, `maxTotalTokens: 0`, 300,000 output tokens and configured $40. Zero disables the optional cumulative request-token guard; it does not increase the child limits. Unknown catalog prices prevent interpreting the dollar limit as an independently enforceable billing cap. Retain request/output/cache usage and unknown cost explicitly.

The public model ID is `deepseek/deepseek-v4.1-flash` and the configured API is `openai-completions`. Provider aliases and combined provider/model keys are private and are omitted from this protocol. Before preparation and execution, privately verify the selected provider and model IDs against the private handoff and use the identical full key for both stages; record that preflight only in private run metadata. Do not publish connection details or credential values. The prior public replay recorded the same model ID and API but did not establish identical provider, service configuration or backend revision, including with the older `deepseek-flash` runs. Report this limitation instead of claiming a controlled same-service causal estimate.

## Source reconstruction and reviewer blinding

Reconstruct the original effective HEAD and full tracked tree, not merely the dataset base commit. Use unchanged original patches, requests, model-authored ledgers and native receipt extraction. Verify patch bytes, effective HEAD, tree, snapshot/report hashes, acceptance IDs and workspace fingerprints before calls. Keep all protected source tests unchanged. The model-authored ledger remains an interpretation, never additional user authority.

The existing source cache contains three complete verified task layers and the verified 16,777,216-byte Matplotlib prefix identified in the JSON. The Matplotlib shallow base cache is retained separately. A leftover 74,288,175-byte download is incomplete relative to the 971,577,772-byte Matplotlib full layer; do not use or describe it as verified full-layer evidence. The existing materializer verifies Git objects, ancestry, tree and exact rendered patch. Preparation still contacts the public registry to check the retained image config and may fetch the fixed public base if missing; cached bytes do not make the existing command an offline procedure. Fail closed on mismatch instead of substituting a current image/source revision.

Keep the previous source-only limits: eight Matplotlib resource symlinks are Windows Git placeholders, Astropy's `astropy_helpers` gitlink is uninitialized, ignored/generated products and implementation scratch files are absent, and original Python environments are not recreated. Historical configured checks remain `unconfirmed`; no source/test/check is rerun. Retain native command output and its bounded truncation/omission limitations. A model acceptance is not fresh host verification.

Inspection confirmed all four original snapshots have **no `task.behavior` and no calibration**. Consequently the attachment's C discrimination rule and the parent's `behaviorCheckDiscrimination`/host override are **unmeasured by this same-patch replay**. Do not synthesize a baseline, calibration receipts, comparison outcomes or evaluator labels. Fingerprint source and dist for `behavior`, `review-discrimination`, and the consumed `result`/`plan` dependencies. `result` is imported by the handoff; `context` is not in the replay's runtime import graph and is not added. Capturing the host-guard file identifies the surrounding intervention; it does not activate the guard or measure it. No task/result implementation is changed here.

Candidate roots must be separate from Forge's checkout and from all protocol/grading directories. Supply only the ordinary current product handoff and allowed source context to the existing read-only Pi reviewer. Use the existing `read`, `grep`, `find`, `ls` policy with no shell, mutation, extensions, MCP or delegation. This is a tool policy, not an OS sandbox.

**Never supply this protocol, the user attachment, scoring rules, official labels, official test patches/results, previous reviewer decisions or adjudication notes to the reviewer.** Do not alter the original request or ledger to insert dotted-endpoint/Nx1 expectations, hidden test names, exceptions, or threshold hints. Existing historical visible receipts may mention ordinary source tests; preserve them without appending official output. Official artifacts are experimenter-only identity/label evidence. No new oracle or calibration checks enter this replay.

## Preregistered readout

Keep the driver's report and per-review records immutable. Its `decision: defect_blocked` is a coarse category and **does not establish targeted detection**. Add a separately identified experimenter-side readout after completion, never rewriting raw verdicts, issue kinds, acceptance statuses or official labels. Inspect the actual returned finding and supporting source/receipt context; do not score keywords alone.

The driver retains `rawReviewText` and its hash locally, `rawModelVerdict` before `parseReview` normalization, `normalizedModelVerdict`, and `effectiveModelVerdict`. A/B targeted readout concerns the **raw model judgment**, with valid coverage and concrete findings still required. Existing product normalization remains visible separately; the historical replay does **not** invoke `constrainReviewDiscrimination` or another C host override, and records `hostGuardApplied: false`. Effective and normalized verdicts therefore agree. If no final text is returned because of budget/format/runtime failure, the raw verdict is unavailable (`null`), not an invented judgment; the failed slot remains retained. Never credit a host-downgraded ready as raw defect detection. Earlier frozen outputs are not backfilled with these new fields.

Use mutually exclusive readout outcomes per scheduled slot:

- `accepted`: valid exact acceptance-ID coverage, `ready`, all criteria met, empty issues, unchanged candidate and in-root reader audit.
- `targeted_changes_requested`: valid `changes_requested` with a concrete blocking issue naming the relevant public path, trigger and behavior below. A target mentioned only in notes or followed by `ready` is not detection.
- `other_concrete_changes_requested`: a concrete block that does not identify the retained official failure mechanism. Preserve its reason even if reasonable; do not award targeted-detection credit.
- `abstained`: insufficient evidence, ambiguity without a concrete defect, missing execution, invalid/inconsistent format or coverage, budget/provider/runtime failure, or a nonconcrete block. Preserve the specific cause, driver decision and issue kinds.
- `not_run`: a scheduled slot that never started after a fatal stop. Do not invent a model verdict for it or call the batch complete.

Record integrity separately. A changed workspace, escaped reader path or missing audit evidence invalidates the slot and makes it ineligible for acceptance or detection; retain it in the planned denominator and report it. All per-case fractions have denominator **3**, including abstentions and invalid/unexecuted slots. A positive result requires all 12 scheduled slots completed and integrity checks satisfied. Retain every failure and partial batch; no outcome-driven replacement run or selective repetition is permitted.

**Flask target:** a concrete finding at the dotted **route endpoint** rejection/exception contract, with a relevant path and triggering endpoint example. The retained official failure is `tests/test_blueprints.py::test_route_decorator_custom_endpoint_with_dots`: the endpoint path still raises `AssertionError` where that official test expects `ValueError`. A constructor guard on a dotted **blueprint name**, a generic demand to update stale dotted-name tests, or a failure in `test_inject_blueprint_url_defaults` alone is a different block and earns zero targeted credit. A claim concerning dotted endpoints that contradicts rather than diagnoses the retained failure must be recorded as a disagreement, not automatically counted by topic.

**Flask authority caveat:** the original issue asks to reject dotted blueprint names and notes that endpoint-name checking already existed; it does not explicitly require changing the endpoint exception type. Preserve that text. For every endpoint finding, record the reviewer's exact claim, source/visible-evidence justification, whether it aligns with the retained official failure, and whether user authority is explicit, inferred or unresolved. Report official-aligned findings and requirement disagreements together. Even if the numerical threshold is met, describe it as targeted official-aligned blocking on an underspecified case, not proof that an unambiguous original requirement was violated. Never retrofit the request or feed the official expected exception into a reviewer prompt.

**Matplotlib target:** a concrete finding that the new blanket two-dimensional-input rejection in the affected 3D plotting path rejects the previously accepted **Nx1 / `(n, 1)` column-shaped input**, with a path, trigger and compatible behavior/remedy. The retained failure is `lib/mpl_toolkits/tests/test_mplot3d.py::test_draw_single_lines_from_Nx1`. A generic concern about unspecified multi-column input, a docstring note, missing optional test execution or an unrelated test-update request does not count. The reviewer need not name the hidden test; the actual boundary mechanism must be identified.

For each row record slot, case, repetition, raw/normalized/effective verdicts, host-guard status, driver decision, coverage, issue kinds, integrity, readout outcome, target relevance, finding excerpt/reference, path/trigger, requirement-authority assessment and disagreement reason. Report unrelated concrete test-update blocks in their own count, not merged with targeted blocks. Retain disagreements and uncertain classifications explicitly; unresolved relevance gets no targeted credit. Control-case blocks remain recorded against the retained passing label even when they raise a plausible additional concern; do not regrade or change labels to make the intervention look better.

## Decision thresholds, frozen before new calls

Apply the control guardrail before any positive conclusion. Report the counts for every case, not only an overall label.

| Observation | Preregistered interpretation |
| --- | --- |
| Flask **and** Matplotlib each have at least **2/3 targeted concrete `changes_requested`**, Astropy **and** SymPy each retain at least **2/3 accepted**, all 12 slots completed with integrity | Meets the fixed diagnostic efficacy threshold, subject to the Flask authority caveat and model/service limitation. No general safety or end-to-end quality claim. |
| **Either** Astropy **or** SymPy acceptance is **at most 1/3**, whatever the failing-case detections | Overblocking/rollback criterion met. Report whether losses were concrete blocks, abstentions or infrastructure; do not narrow the criterion to code-defect blocks or pool the two controls. This document does not perform a rollback. |
| Flask or Matplotlib remains **3/3 valid `ready`/accepted** | Ineffective for that case; overall success is not established. |
| A failing case moves from `ready` to `insufficient_evidence` or another abstention | Abstention, not detection or a successful repair. Report reduced acceptance separately. |
| A failing case has concrete blocks only for unrelated stale/test-update concerns | Other concrete blocking, not targeted official-failure detection. |
| Other mixed outcomes, incomplete batch, unresolved adjudication or integrity failure | Efficacy not established; retain the full breakdown and limitations without relaxing the threshold or adding runs. |

## Parent preparation and run handoff

No new driver flags are necessary: existing `--prepare-only` and `--run-prepared` preserve the protocol and serial schedule. The driver does **not** consume this JSON or enforce the targeted readout, full provider identity, or all decision/authority rules. Those remain explicit experimenter preflight/adjudication duties; no production semantic change is implied.

After the parent finishes its product work and final build and explicitly signals that the build is frozen, set the variables below from the private handoff. The output directory must be new and absent; source/cache/config paths must not be candidate roots. Do not reuse the completed replay directory. Run these two stages separately, inspecting the first before permitting model calls:

```powershell
node scripts/replay-swebench-review.mjs --model $MODEL_KEY --config-home $CONFIG_HOME --source-run $ORIGINAL_RUN_ROOT --graded-run $REGRADED_RUN_ROOT --cache $SOURCE_CACHE --output $NEW_REPLAY_ROOT --prepare-only
node scripts/replay-swebench-review.mjs --model $MODEL_KEY --config-home $CONFIG_HOME --source-run $ORIGINAL_RUN_ROOT --graded-run $REGRADED_RUN_ROOT --cache $SOURCE_CACHE --output $NEW_REPLAY_ROOT --run-prepared
```

Before the second command, verify `prepared: true`, zero results/no model-call start, exactly four cases, the patch/tree/snapshot/report and cached-transport identities in this preregistration, original acceptance IDs, exact 12-slot order, standard/parent limits, `medium`, a private preflight of the full selected provider/model key, no leaked experimenter material and unchanged candidates. Record SHA-256 of this Markdown and JSON beside the new run artifacts, plus final source/dist/package/runtime identities and generated handoff/protocol hashes. Inspect model inputs locally without publishing private session content. The driver's model field stores only the model-ID suffix, so independently record the full key only in a private run manifest and use exactly the same `--model` argument for both stages.

Preserve temporary candidate directories between stages. Preparation may use network access for public source validation but makes no reviewer call with `--prepare-only`; it still imports existing `dist` files, so do not prepare against stale/pre-final output. Preserve every failed attempt in a new directory. After any model call, retain partial outcomes rather than altering the registered cohort or restarting to replace them. If product/harness bytes change after preparation, retain that attempt, rebuild separately, and prepare a new one before any further calls under a documented amendment.

Publish only a reviewed allowlist: protocol/final-code fingerprints, public model ID/API, immutable candidate/source identities, per-slot verdicts and adjudication, all counts/failures, usage, and limitations. Exclude provider aliases, combined provider/model keys, private filesystem paths, connection details, credentials, full sessions and raw private transcripts. Local ready paths and commands are provided separately in the tool handoff, not in this document.
