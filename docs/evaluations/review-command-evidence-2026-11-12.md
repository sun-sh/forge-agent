# Independent review command-evidence regression — 2026-11-12

The implementation at `b574ddb269c95f05bbfbeb25a52f2bc42c294ce1` supplies the fresh, read-only Pi reviewer bounded native shell receipts from the latest implementation phase. These historical observations retain visible failures, zero-test runs, upstream/source truncation, excerpt hashes and omissions. They do not attest to the current workspace, replace the configured verification gate, or add execution permissions. The original user request remains authoritative over the model-authored requirement ledger.

本次修复给独立只读 reviewer 补充最近实现阶段的有界命令回执，保留失败、零测试和截断标记；历史回执不会自动升级为当前版本验证。通过新提示提醒 reviewer 对照原请求，仍不等于实现了通用的要求来源证明。

## Scope and protocol

- Original ablation: [five issues × three repetitions × three arms](swebench-ablation-2026-11-12.md), retained unchanged.
- New run: [43204052484](https://github.com/sun-sh/forge-agent/actions/runs/43204052484), the new code above, `deepseek-flash`, `medium`, Planned, one repetition each of Astropy 6938 and SymPy 18189.
- These two cases were selected because the old review arm blocked officially passing patches. This is a purposive repair-path regression, not a representative quality estimate.
- New model samples are not paired replay of the old implementation patches. A better or worse result cannot be attributed solely to receipt handoff.
- Same frozen per-task limits: 30 minutes, 160 parent model turns, 400 tool calls and 200,000 output tokens; cumulative request-token cap disabled; catalog cost unknown. The existing local reviewer limit remains unchanged.
- Baseline/gold validation, test/config protection, current host syntax checks and independent official grading remain required. Hidden acceptance is not returned to the model.

## Real-model outcome / 真实模型结果

Both retained executions passed official grading **and** Forge completion. Tests/configuration stayed unchanged, patches were non-empty and accepted, and false completions / infrastructure failures were 0.

| Instance | Official resolved | Forge completed | Correct completed delivery | Time | Turns / tools | Request tokens | Reviews / repairs |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| astropy__astropy-6938 | Yes | Yes | Yes | 563.7 s | 111 / 121 | 4,763,595 | 2 / 1 |
| sympy__sympy-18189 | Yes | Yes | Yes | 123.2 s | 29 / 28 | 476,999 | 1 / 0 |

Total: 2/2 officially resolved and delivered, 140 model turns, 149 tool calls, 5,240,594 request tokens (4,785,792 cache-read) and 68,208 output tokens. Cost is unknown. These two new samples are not added to the earlier 45-execution ablation.

本次两题均通过官方判题并完成交付。它说明修复后的路径可用，不能证明独立审阅整体更优，也不是对旧六次工作流停止的逐一重放。Astropy 仍耗时约 9.4 分钟，首次审阅接近 24 回合上限，成本问题仍保留。

### What the reviewer actually received

- SymPy’s single fresh reviewer received five historical command receipts, recognized the observed full-module test output and returned ready in five model turns.
- Astropy’s first handoff contained **zero** command receipts: implementation had not supplied the required test run. The reviewer requested changes for missing evidence in 23 turns. The bounded repair then ran checks; the second handoff carried 12 receipts with 17 earlier receipts explicitly omitted, and the fresh reviewer returned ready in eight turns. One repair was consumed.
- The handoff therefore preserves a genuine missing-evidence stop rather than automatically accepting empty receipts. It also transfers evidence once it exists. Requirements, current host verification and protected paths remain enforced.
- The first Astropy reviewer’s 23-turn search remains expensive for a small patch. Receipt transport fixes one concrete gap; focused reading and evidence creation before review still need improvement.

SymPy 的 reviewer 已真实收到五条命令回执；Astropy 首次确实没有测试回执，仍被阻断，修复后带着实际记录再次审阅才完成。没有放宽“无证据不通过”的门槛。代码质量或效率收益仍需三组同条件重复实验，而不是从这次 2/2 推导。

## Fingerprints

- Model code revision: `b574ddb269c95f05bbfbeb25a52f2bc42c294ce1`.
- Package: `b5a6b3906c6b08b5cd1019243dc52df01efd8bdf4d315af88c67f094b223c82d`.
- All 206 packaged dist files: `5cef772d99a39481568d2355c9bb294f4d211f4efc4dc0fe59c5fc4ab4f4818c`.
- Model harness: `8c8b95443085bab90241e8d4daa4e8716190cc93b205f2e220f2c32167c5ceeb`.
- Cohort: `6f849fab0a72be3783f518cd07ed75da3c9dae18b084cc3b3529826df4ed84c6`.
- Validation: `0c925e945e267c43cdf6473ba3d290cbb581e010c0f8e1c9b8f5023eb11c3e1a`.
- Official harness commit: `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e`.

The [allowlisted aggregate](review-command-evidence-2026-11-12.json) records both patch hashes, official/host verdicts, review attempts, usage and immutable identities. Full patches and original reports remain in the [GitHub artifact](https://github.com/sun-sh/forge-agent/actions/runs/43204052484). No endpoint, credential or private/local path is published.

## Engineering qualification

[Final code CI](https://github.com/sun-sh/forge-agent/actions/runs/43203892989) passed Windows/Ubuntu × Node 22/24, including typecheck, build, CLI/bin and tarball checks: 50 test files, 704 tests on Windows and 701 on Ubuntu (Windows-specific path cases explain the difference). The seven final receipt tests and the 110-test handoff/controller group pass locally. A real Pi shell → new read-only reviewer fixture passes without sharing the parent conversation or adding shell tools.

Offline replay of the actual retained SymPy log recovers the previously omitted “43 passed, 1 skipped, 2 expected to fail” result; Astropy’s latest implementation receipts retain visible failures. This checks evidence transport rather than new model quality.

An earlier long local check ran while source/tests were still being updated and combined a cached earlier helper with a new source-truncation assertion (703 passed, one failed). It is retained as a mixed-workspace failure, not counted as a clean check at the final revision. Stable-source focused reruns and the clean four-platform CI above pass.

所有质量结果来自这两次新运行的实际官方报告、补丁指纹及宿主终态；工程回归和旧日志离线重放单列，不冒充真实编码成绩。
