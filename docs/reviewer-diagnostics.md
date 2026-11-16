# Reviewer call timing and native boundary evidence

## Observable model calls

Forge observes Pi provider hooks; Pi still owns requests, streaming, retries and agent/model/tool turns. It does not wrap the transport or introduce another loop. Delivery-review child records expose optional `reviewTelemetry` in the subagent API/detail and persisted record; `reviewGate()` also returns `reviewLatency`, derived by `summarizeReviewTelemetry`. Existing records without telemetry stay unknown, not zero and not inferred from total duration divided by turn count.

Each observed call records sequence/turn, UTC start, monotonic elapsed time, outcome, completed duration, first response headers, first parsed stream event, first nonempty text/thinking/tool delta, serialized payload bytes, first HTTP status and reported numeric usage. No payload, credential, endpoint, header value or generated content enters this telemetry. Payload bytes are not tokens. Provider SDK retries may occur inside one hook-observed call, so the count is not a raw HTTP-attempt count.

The measurement window starts at `before_provider_request` and ends at the assistant `message_end`. Tool execution/setup between requests is excluded. Time includes provider queueing/prefill/thinking/generation, transport, internal SDK retries and local processing; neither a slow median nor first-content delay identifies a network/provider fault by itself. First stream activity can be an empty role/control event; first content is reported separately. Non-streaming/certain provider adapters may not expose all milestones; those fields stay null.

Successful completed calls and terminal errors have separate distributions. The median is the middle value, or the mean of the middle two values for an even sample; p90 uses nearest rank. Running, cancelled, duration-budget exhausted, interrupted and superseded calls retain an observed elapsed lower bound and null completed duration. They are excluded from the successful-call median and counted separately, including lower bounds over 60 seconds. A 300-second reviewer timeout is an abstention, not detection and not evidence of inadequate intelligence.

A successful-call median strictly over 60 seconds selects `investigate_call_latency`: inspect first-content waiting, output volume, request size, model/provider throughput and the call path before further prompt changes. This is an operational heuristic, not causal attribution or a reason to raise turn limits. Censored/absent samples select `collect_more_data` unless the observed successful median already supplies that signal. Always retain sample counts and censoring; a small faster sample cannot explain away prior timeouts.

### Persistence and recovery

Small strict-schema `forge.review_call` entries checkpoint start, headers, first stream/content and end into the owning parent Pi session. They do not rewrite the full child prompt for every token. Final child records retain the bounded log; at most 256 observed calls are retained, with further observations counted as dropped. Dropping telemetry does not change the model budget. Ownership is checked on restore; normal conversation forks do not adopt another parent's child records.

On restart an in-flight call becomes interrupted with only the last durable observed lower bound. There is no monotonic clock spanning processes, so no completed duration is reconstructed from wall timestamps. Malformed timing entries are rejected. Cancellation/budget exhaustion never becomes a completed-call latency merely because a provider reports the abort as an error.

The [fixed-input latency diagnostic protocol](evaluations/review-call-latency-protocol-2026-11-16.md) measures one new review with the exact previous Flask handoff. It does not change the old twelve-review dataset or measure a new detection rate. Synthetic-clock and local streaming fixtures establish instrumentation behavior, not provider performance.

## Native boundary evidence in review handoff

New handoffs include `nativeBoundaryEvidence` before historical command noise. For each frozen check it pairs the original-request quotation, check kind, expectation, command hash, actual baseline and candidate exit/status/output hashes, run/tool-call identities and a host-derived comparison. The baseline is the actual admitted pre-implementation workspace, including pre-existing user edits; it is not replaced with Git HEAD or reconstructed after implementation.

Both sides reference full retained native receipts in `independentBehaviorChecks`. Side-by-side output previews are at most 400 characters and explicitly mark truncation; a preview is navigation, not complete test evidence. Attribution requires a valid current calibration/comparison, the same frozen command, unique native receipts, request anchoring, complete output and matching output hashes/lengths. Missing, duplicate, stale, truncated, mismatched or unanchored observations stay unconfirmed. Saved comparison flags are not accepted as new proof.

Exactly matching historical copies may reference their full native receipt instead of repeating the output. Matching requires the same tool-call ID, native tool, command hash and output hash. Source-truncated/different copies are retained. Original failure/zero-test/omission counts remain visible; `representedByNativeReceipts` explains every removed duplicate. No failed evidence is relabeled passing and no full patch, requirement or native receipt is truncated to meet a latency target. Existing handoff-size bounds still fail closed.

A historical claim such as “2D input was already broken” requires a baseline receipt for that exact case or a pre-change source path. A different failing shape, the current implementation or a docstring cannot excuse narrowing. Without evidence the affected acceptance remains unconfirmed. This adds an instruction; it does not turn prose into a host-verified theorem. A native boundary pass-to-fail observation blocks the existing receipt gate even if a scripted reviewer says ready, but still needs contract/environment analysis before being called a source defect.

A/B/C/D remain in place. All-identical checks do not establish patch effect; typed missing execution still requests `run_required_tests` with zero code-defect count. Result semantics, protected paths, trust checks, parent limits and reviewer budgets are unchanged. Validating these engineering paths is distinct from qualifying the historical Flask/Matplotlib misses or a general safety claim.

## Release qualification boundary

Planned review remains experimental. The [release boundary](reviewer-limits.md) separates enforceable host controls, controlled fixtures and unqualified model-quality hypotheses. The [final fixed-patch experiment](evaluations/reviewer-boundary-2026-11-16.md) retains unavailable native evidence rather than inferring efficacy or a theoretical ceiling from it. No further review mechanism or default allowance is added for publication.
