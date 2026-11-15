# Fixed-input reviewer call-latency diagnostic — 2026-11-16

**The new sample does not reproduce a successful-call median over 60 seconds.** One fresh reviewer on the exact old Flask handoff completed six observed model calls. The median completed duration is **9.2795 seconds**, maximum/p90 **28.173 seconds**, and median first-content wait **0.813 seconds**. There are no error/censored calls in this sample.

这次测量不支持把旧超时直接归因于“每次调用太慢”：当前六次调用均低于 60 秒，但旧运行没有单次计时，因此旧超时原因仍未确认。不能用总耗时除以回合数补造旧数据，也不能由这一次较快探针推断服务已稳定或提示已足够。

[Preregistered protocol](review-call-latency-protocol-2026-11-16.md) · [numeric aggregate](review-call-latency-2026-11-16.json) · [instrumentation/native evidence contract](../reviewer-diagnostics.md) · [unchanged compatibility results](reviewer-compatibility-2026-11-16.md)

## Registered scope and identity

This is one fixed-input observability probe, not a new coding sample, detection-rate estimate or three-arm ablation. The old Flask planned.r1 patch and exact 30,026-character handoff were retained. No new historical-claim clause, paired evidence, official labels, hidden tests or previous decisions were added to that old input. The source-only Pi reader policy and workspace checks held; eight reader calls stayed inside the candidate, and the source fingerprint was unchanged. No concurrent test suite ran during model calls.

The protocol was committed before calls at 76ed389068b9ac86f17208c74ad5a5385f97319b. Instrumentation changes were present in the working tree, so this is explicitly a dirty-tree execution identified by captured source/dist/script hashes, not a clean-commit claim. Their exact bytes are retained in the local harness snapshot. Model deepseek/deepseek-v4.1-flash, openai-completions, medium thinking; standard 300 seconds / 24 turns / 120 tools / 32,000 output tokens / configured $4 and existing parent defaults remained unchanged. Prices are unknown; measured cost is null.

| Identity | SHA-256 / value |
| --- | --- |
| Harness/source/dist fingerprint | 1de515f70391f5b5f5773265a44e236540c72f8f351dd2f4fc6808fa1151d7e0 |
| Protocol | 9c420a70ba98894a31610b27c11734ffab9fa71b63b1e78633eedea23eb1b4fc |
| Exact old handoff | 30eb8b67b8099bd9ae524ff018a8d0dfd3bb8c26539da227648d95122004c390 |
| Fixed patch | 770690aee527cfcd6752d1ddc9d66866709be021b54e4dcc49f8affa1b859191 |
| Raw private report | 9fdb37a4ee298c27b6f064e84084df9f85238f28682d8853e0ba0e5f80564a9c |
| Numeric call-event journal | 22f2cd25df7e6b55a31d423b1e65b176c069ab1628ce4850a38f1557b6e853ba |
| Calls started / probe finished (UTC) | 2026-11-15T17:53:05.075Z / 2026-11-15T17:54:20.740Z |

## All individual observed calls

| Call | Completed seconds | Headers seconds | First content seconds | Payload bytes | Reported output tokens | Outcome |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 4.990 | 0.623 | 0.643 | 38098 | 571 | completed |
| 2 | 1.618 | 0.945 | 0.988 | 64074 | 122 | completed |
| 3 | 13.569 | 0.618 | 0.635 | 66599 | 1282 | completed |
| 4 | 22.735 | 0.870 | 0.894 | 82556 | 2414 | completed |
| 5 | 2.296 | 0.928 | 0.949 | 95569 | 217 | completed |
| 6 | 28.173 | 0.713 | 0.732 | 96453 | 3024 | completed |

The successful-call durations are 4.990, 1.618, 13.569, 22.735, 2.296 and 28.173 seconds. The even-sample median is the mean of 4.990 and 13.569 seconds. First headers median is 0.7915 seconds; first content median is 0.813 seconds. The first-content measure includes nonempty thinking/text/tool deltas, not an empty role/control packet. Reported output counts and cache-read usage for every call remain in the aggregate.

Payload grew from 38,098 to 96,453 bytes as evidence accumulated. Durations are not monotone with payload size, and output volume/cache usage also vary. This supplies useful diagnostics, not an input-size ablation or causal throughput model. Most measured time in the longer calls follows the first content; it cannot be labeled pure network waiting.

## Preregistered interpretation

The greater-than-60-second successful median rule is not triggered; summarizeReviewTelemetry reports no_slow_call_signal for this sample. The old Flask r2/r3 and Matplotlib r1 timeout causes remain unconfirmed because those runs recorded only whole-review time/usage. No historical latency is backfilled, no old abstention is replaced, and these six calls are not added to the old three-review denominators. An absence of slow calls in one correlated conversation does not exclude intermittent provider/load delays. Backend identity, cache state and output behavior were not controlled against the prior runs.

The reviewer returned ready; that is contextual metadata, not a new quality score or evidence for the new clause/native-pair intervention. The original four-patch replay remains unchanged and below its registered efficacy threshold. A/B/C/D and all completion/result semantics remain in place.

## Separate engineering evidence

Synthetic monotonic-clock tests cover individual windows, successful/error distributions, ordinary even medians, the 60-second routing rule, censored cancellations/budget stops/supersession, bounded history and rejection of raw header fields. Actual Pi sessions with a local scripted provider verify per-request hook wiring, first-content timing, small parent-session checkpoints, restore and cancellation. These are instrumentation tests, not provider-performance samples.

A separate native Web regression executes the same frozen commands before/after implementation: reproduction changes fail-to-pass, while the blank-input boundary changes pass-to-fail. The reviewer receives the real paired exit/status/hash evidence, and the existing gate blocks a scripted ready. Its first test attempt exposed a fixture parser assuming plain text instead of Pi text blocks; that parser was corrected and the unchanged native policy test passed. This establishes evidence wiring and blocking for a controlled case, not repair of the upstream Nx1/Flask misses.

New production handoffs pair original-request anchors with native receipts and reuse only exact historical copies. Historical claims require matching baseline execution or a pre-change source path; absent evidence remains unconfirmed. No requirements/full patch/native receipts are trimmed to manufacture lower latency. Further quality claims need separately registered native-boundary qualification, not another round of prompt-only acceptance claims.
