# Final native-boundary reviewer experiment — 2026-11-16

**Efficacy is not established. Preparation produced attributable native boundary evidence in 0/4 cases, failing the prerequisite before reviewer calls.** All 12 fixed reviews still ran as registered. Flask has 0/3 targeted findings; Matplotlib has 1/3, plus one related concrete Nx2 finding outside the registered Nx1 target. Both correct controls retain 3/3 acceptance. Two duration stops are abstentions.

结论：本轮没有通过门槛，也没有成功检验“可用的原生边界证据能改善漏检”这一假设。四例证据准备均不合格，不能把工程/协议失败解释成隐藏测试的理论上限。按约定停止追加审阅机制，保留失败并发布有明确边界的版本；默认仍为自适应，规划及独立审阅仍属实验能力。

[Preregistered protocol](reviewer-boundary-protocol-2026-11-16.md) · [allowlisted aggregate](reviewer-boundary-2026-11-16.json) · [unchanged prior compatibility results](reviewer-compatibility-2026-11-16.md) · [release boundary](../reviewer-limits.md)

## Fixed inputs and qualification rule

The same four original `planned.r1` patches, issue text, acceptance IDs and historical receipts are retained. Each receives three fresh, serial, rotated independent reviews with `deepseek/deepseek-v4.1-flash`, OpenAI Completions, medium thinking and unchanged standard limits: 300 seconds, 24 turns, 120 tool calls, 32,000 generated tokens and configured $4. The sole existing same-session format correction is available; no final reviewer uses it. No implementation is regenerated, candidate substituted, official grading rerun or hidden label/test disclosed. Source-only local reviewers use readers, not test execution. The host discrimination guard is not invoked; raw/normalized/effective decisions remain separate.

Passing requires Flask and Matplotlib **each ≥2/3 targeted concrete findings**, each control ≥2/3 acceptance, all 12 integrity-valid slots, and at least one attributable native pair **in every case**. An abstention, missing evidence or unrelated finding earns no target credit. Either control ≤1/3 accepted would trigger the registered control rollback. No control rollback is triggered; both efficacy prerequisites and numerical targets fail. An invalid preparation is not evidence that usable native evidence is ineffective.

## Evidence preparation: workflow completion is not qualification

The old snapshots lack calibration; replaying them unchanged would not test this hypothesis. One existing original-image Pi capture per exact patch therefore ran before admission, on [Actions run 43789515334](https://github.com/sun-sh/forge-agent/actions/runs/43789515334). Capture stops at the review adapter before any final reviewer, preserving task/native evidence rather than generating a new patch. The parent retains the prior 1,200-second/80-turn/200-tool/100,000-output/configured-$20 allowance; designer/diagnosis children retain 180 seconds/12 turns. No limit, schema or protected-path rule is relaxed.

| Case | Frozen pairs | Native exits baseline → candidate | Preparation failure | Attributable pairs |
| --- | ---: | --- | --- | ---: |
| Flask | 3 | B1 1→0; B2 1→0; B3 1→1 | Diagnosis still exceeds the maximum three findings after its one format correction; unresolved attribution | 0 |
| Matplotlib | 0 | No ready plan | Designer still emits a `read` call instead of final plan JSON after format correction | 0 |
| Astropy | 0 | No ready plan | Designer still emits a `read` call instead of final plan JSON after format correction | 0 |
| SymPy | 3 | B1/B2/B3 1→0 | Diagnosis retains forbidden `command`/`expectation` finding fields after format correction | 0 |

All captured candidates/protected paths remain unchanged. The capture workflow is green because it reached the intended evidence-capture boundary, **not because calibration succeeded**. Both six-pair navigation observations and complete native receipts remain; every comparison is unconfirmed. No saved failure is stripped, no programmatic-shell receipt is renamed native parent shell, no design timestamp is invented, and no preparation is resampled. Four report hashes and the zero-result admission manifest freeze 0/4 eligibility before calls.

Capture uses the existing benchmark alias `deepseek-flash`; equivalence to the locally configured final reviewer/backend is not established. The existing workflow also performs four small provider preflights, one per case. These pre-existing calls are retained and are not part of the 12 reviewer denominator; the protocol's “no preflight added” must not be read as zero preparation preflights. Prices remain unknown.

## Every registered result retained

| Candidate | Accepted | Targeted blocks | Other concrete blocks | Abstained | Attributable native pairs |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pallets | 1/3 | 0/3 | 0/3 | 2/3 | 0 |
| Matplotlib | 1/3 | 1/3 | 1/3 | 0/3 | 0 |
| Astropy | 3/3 | 0/3 | 0/3 | 0/3 | 0 |
| Sympy | 3/3 | 0/3 | 0/3 | 0/3 | 0 |

| Slot | Candidate/repetition | Raw / normalized / effective | Adjudication | Turns | Seconds |
| ---: | --- | --- | --- | ---: | ---: |
| 1 | pallets__flask-4045 r1 | ready / ready / ready | accepted | 4 | 113.7 |
| 2 | matplotlib__matplotlib-23563 r1 | ready / ready / ready | accepted | 11 | 150.7 |
| 3 | astropy__astropy-6938 r1 | ready / ready / ready | accepted | 5 | 153.5 |
| 4 | sympy__sympy-18189 r1 | ready / ready / ready | accepted | 3 | 41.3 |
| 5 | matplotlib__matplotlib-23563 r2 | changes_requested / changes_requested / changes_requested | targeted_changes_requested | 11 | 260.6 |
| 6 | astropy__astropy-6938 r2 | ready / ready / ready | accepted | 4 | 86.8 |
| 7 | sympy__sympy-18189 r2 | ready / ready / ready | accepted | 2 | 48.0 |
| 8 | pallets__flask-4045 r2 | — / — / — | abstained | 3 | 300.0 |
| 9 | astropy__astropy-6938 r3 | ready / ready / ready | accepted | 9 | 167.9 |
| 10 | sympy__sympy-18189 r3 | ready / ready / ready | accepted | 3 | 74.6 |
| 11 | pallets__flask-4045 r3 | — / — / — | abstained | 3 | 300.0 |
| 12 | matplotlib__matplotlib-23563 r3 | changes_requested / changes_requested / changes_requested | other_concrete_changes_requested | 13 | 277.4 |

All 12 source-workspace/reader checks pass. The ten returned reviews cover every original acceptance ID; two timeouts have no final verdict. Raw, normalized and effective returned verdicts agree. There is no new official resolution result or end-to-end delivery-gate score. Driver `defect_blocked=2` is a coarse category; only one meets the registered target.

### Findings and conservative target attribution

**Flask:** r1 returns ready and treats dotted-blueprint stale-test failures as authorized by the requested rejection; B3 is an inherited Werkzeug `as_tuple` environment failure. Neither identifies the retained dotted **route endpoint** exception-contract failure. R2/r3 hit 300 seconds after three turns without a verdict. Counts remain 0/3 targeted, 1/3 accepted, 2/3 abstained. Preserve the authority caveat: the original issue explicitly rejects dotted blueprint names, not a particular exception type for dotted route endpoints. Do not feed the official expected exception into a new prompt to manufacture alignment.

**Matplotlib r1:** ready still rests on a broad claim that ndim>1 input was previously broken. It does not address the Nx1 boundary. This is not target detection despite the historical-claim instruction.

**Matplotlib r2:** a concrete issue at `lib/mpl_toolkits/mplot3d/axes3d.py` gives `ax.plot(np.arange(3), np.arange(3)[:, None], 0)`, traces pre-change column splitting and explains that the new blanket guard rejects the previously usable column vector without original-request authority. This is the one registered Nx1 finding. It explicitly relies on pre-change source, not an available paired native check.

**Matplotlib r3:** a concrete issue gives a 3×2 y array with 1D x, traces the two-column source path and blocks the blanket guard. It is a related and potentially useful compatibility finding, **not a demonstration of the registered Nx1/(n,1) boundary**. The protocol excludes multi-column concerns without that boundary and gives unresolved target relevance no credit. Preserve it as `other_concrete_changes_requested`; do not broaden the scoring rule after seeing the result. No new external grading of that Nx2 example is performed.

**Controls:** Astropy and SymPy each return ready 3/3. SymPy reviewers cite some observed fail-to-pass receipts; unresolved calibration still prevents promoting them to attributable boundary evidence. Control acceptance is a selected diagnostic result, not a general false-block estimate or proof of calibrated checks.

## Individual model-call latency, including censoring

There are **71 hook-observed calls: 69 completed and two duration-censored**. Successful-call median is **12.418 seconds**, nearest-rank p90 **61.626 seconds**, maximum **195.391 seconds**. Median first nonempty content across 71 observed calls is **1.124 seconds**. Calls are Pi-hook observations, not raw HTTP attempts; no failed/error call is silently pooled into the successful distribution.

The aggregate median does not exceed the registered 60-second heuristic, but this must not hide Flask r3: its two completed calls have median **115.7975 seconds**, selecting `investigate_call_latency`. Flask r2 has a 56.7365-second completed median and an approximately 186-second unfinished third call; r3 also has an unfinished third call. Both long censored calls retain null completed duration and an elapsed lower bound. First content arrives before their eventual cutoff, so these data do not identify a pure connection fault. Queueing, model generation, internal retries, payload size and transport cannot be separated causally here. Do not increase turns or infer inadequate intelligence from timeouts.

Maximum completed review length is 13 turns, below the unchanged 24-turn allowance. Reported request tokens total 1,624,012 and output tokens 112,680; interrupted streams can omit final usage, so these are observations, not complete billable totals. Actual cost remains **null**, not zero or free. Full per-call timing and per-review priority are in the aggregate.

## Frozen identities and source limits

| Identity | Value |
| --- | --- |
| Production review base | `77627049978c9f110e5f8cdbfd235a3f9735505f` |
| Capture code | `2f61645d430227273296a4df1e2c89e9c4b3e6b2` |
| Final reviewer execution code | `b143cc6301e96bf8373ebc1fb124e732ae0c7c66` |
| Source/dist/harness fingerprint | `0d682aa167f7fa7f7e525b2baebc9516561fdc5497226325cbb03b4b0b38f32e` |
| Native manifest SHA-256 | `4a32b66201413a400bcccfb88da9ef2bda0173becd25591fdf6d54c928935b56` |
| Zero-result admission SHA-256 | `b7599f97ca8b3575be723565d0b9c62102a5604c3290747df97d7dfbc61ca4c5` |
| Final private raw report SHA-256 | `f57e3d6fb2a3d31cd7f5116826023b867a62b06009b6725f5ffede73a4b0956b` |
| Model calls UTC | `2026-11-16T02:22:17.456Z` → `2026-11-16T02:56:08.996Z` |

The aggregate includes registration/protocol hashes, all four capture/source/image/patch/handoff identities, native exit/output/command hashes, per-slot raw-record/final-text hashes and adjudication. All 30 frozen source/dist/harness files were byte-identical at admission and after the last model call, before any release rebuild. No production review module, default budget, result semantic or trust/protection rule changes in this qualification. A later package/version/documentation release does not acquire a new measured model score.

Keep source-only limitations: Matplotlib uses a verified 16 MiB layer prefix and checked Git objects/tree, not a fully verified 971,577,772-byte layer; eight resource symlink placeholders remain. Astropy has an uninitialized `astropy_helpers` gitlink. Original Python environments are only used by separate capture hosts; historical/captured receipts are not current local attestations. Backend revision and cross-service equivalence remain unproven. Full sessions, connection details, credentials and user-specific paths stay private.

## Release decision

The registered efficacy threshold is not met, and the usable-boundary-evidence hypothesis remains **unqualified** because its input prerequisite failed. The result is neither a measured success nor proof of a universal theoretical ceiling. Failed preparation is an engineering/protocol limitation; hidden or underspecified contracts introduce a separate conditional information limit. Preserve both instead of declaring either solved.

Stop review-mechanism expansion for this release. Publish GitHub **v0.2.1** with installable tarball/checksum, bilingual scope and [explicit review limits](../reviewer-limits.md). Adaptive stays default; Planned/native review remains experimental. Seven production review files remain support code for one optional path, not seven proven benefits. No further prompts, modules, resampling, larger default budgets or coding ablation are required to make this release honest.
