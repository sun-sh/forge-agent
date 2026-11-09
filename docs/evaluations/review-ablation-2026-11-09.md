# Review ablation and interruption regression — 2026-11-09

This is a diagnostic experiment on one small public task, **not a general coding benchmark**. Allowlisted measurements are in [the aggregate JSON](deepseek-review-ablation-2026-11-09.json). The original local transcripts, failures and harness snapshots were retained; credentials, provider identifiers/endpoints and local paths were excluded from the public aggregate.

## Protocol

- Task: `config-normalize-cross-file`, small-suite v6, suite fingerprint `7eb63e3ba3408883`.
- Model: DeepSeek V4.1 Flash, medium reasoning, Pi 1.4.0, Windows / Node 24.19.0.
- Arms: direct; planned with independent reviewer; planned-no-review, confined to the evaluator. Each arm uses the same budget within its batch.
- Gates: external assertions, protected-file integrity, current verification and host completion. All must pass for delivery success. Parent usage includes reviewer calls; unknown pricing remains unknown.
- Order: direct → planned → planned-no-review for every repetition. Provider-load/order effects were not randomized. Small-task elapsed time includes setup.

| Batch | Direct | Planned | Planned without review | False completions |
| --- | --- | --- | --- | --- |
| Before handoff correction, 3 repetitions/arm | 2/3 | 0/3 | 1/3 | 0/9 attempted runs |
| After handoff correction, 1 repetition/arm | 1/1 | 1/1 | 1/1 | 0/3 attempted runs |

Zero false completions must be read alongside completion counts. Planned before correction never completed, so its false-completion rate among completed runs is **undefined**, not evidence of perfect reliability. Only one earlier planned run reached its reviewer. This experiment therefore **does not establish the reviewer's defect-detection benefit**.

The initial batch stopped on malformed inspection handoffs, a routine input assumption treated as a blocker, acceptance coverage, and one unconfirmed workspace observation. The corrected run exercised the changed handoff path successfully. Its repetition count and new-install budget differ from the initial batch; it is a regression check, not a statistically controlled before/after improvement estimate. Exact limits and fingerprints remain in each batch.

| Corrected arm | External + host gates | Elapsed including setup | Total request tokens | Generated tokens | Reviewer activations |
| --- | --- | --- | --- | --- | --- |
| Direct | Pass | 34.8 s | 36,828 | 1,817 | 0 |
| Planned | Pass | 100.7 s | See aggregate | See aggregate | 1 |
| Planned without review | Pass | 57.1 s | See aggregate | See aggregate | 0 |

Harness fingerprints:

- Initial: `daf4d62923587a1bbf87a969c9d65b1ad9f65d8a8efbe8b262f6bc360b2bc2e3`.
- Corrected: `8a52fd29ee5e3304daedf478685bc61886ab0a5f820d995a269beb70d8b66887`.

These identify measured code; later changes to continuation or UI are not retrospectively validated by either batch. Future work needs a fully validated repository cohort with repeated arms under identical limits, including defect-detection, cost and false-completion evidence.

## Empty-directory regression

A separate real-model run requested a simple web page with a light/dark toggle in a fresh empty project. Inspection advanced to planning and implementation, and the agent created `index.html` containing a button. The host then stopped at verification because no verification command was configured. It did **not** claim verified completion. This checks the reported read-only-phase blockage, not browser-level correctness of the generated page.

Measured source fingerprint: `8e748e96e827ee6fc2862a0086034136e5964ab96ef83b99d71150d15cb4fb38`; 8 model turns / 5 tool calls, with no copied user session or project. Later source changes remain separate.

## 中文说明

第一次三组真实实测保留了 3/9 通过的失败批次；修正交接后复跑为 3/3。后者每组仅一次、预算也不同，只作为回归，不能声称规划、独立审阅或模型质量提升。原批次 planned 没完成，不能把 0 次错误完成理解成 100% 可靠。另一项空目录网页实测确认可以真正写出 index.html，未配置验证时明确显示待检查。
