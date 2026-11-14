# Frozen upstream behavioral replay

This manual qualification runs the first original Planned patch for Flask 4045, Matplotlib 23563, Astropy 6938 and SymPy 18189 through the new native behavioral gate. It reuses their pinned original Linux/amd64 task images, exact effective HEAD, patch bytes and separate immutable official grading. **It does not regenerate implementations or produce a new SWE-bench resolution score.**

`evals/swebench-lite/behavior-replay.json` freezes the original run IDs, patch/snapshot/grading hashes, image manifest/config IDs, selection, model and limits. `scripts/behavior-replay-protocol.mjs` validates all original identities before admitting a case. The controller reads official labels; the worker gets only the original request, original model-authored brief/plan, selected historical command receipts and candidate patch. Neither official reports nor old reviewer/implementation transcripts enter the container/model context.

Each worker designs checks in a fresh read-only Pi session against the unpatched original source, injects the exact historical patch, executes frozen checks through the existing parent Pi command policy, runs the actual configured syntax/protection gate and starts a fresh real reviewer. `verifyRetries=0` fixes the initial-candidate decision; no repairs or candidate resampling occur. Check-design failures, missing receipts, budgets, changed protected files and transport failures remain separate and retained. The original acceptance labels are only compared after product decisions; a block due to an environment failure is not a defect detection.

The dedicated `codex/upstream-behavior-qualification` branch starts this protocol when its runtime/harness changes; documentation-only result updates do not resample it. Run `.github/workflows/behavior-upstream.yml` manually with `case_ids=all` or a subset of those IDs. It uses the existing `FORGE_BENCHMARK_API_KEY`/`FORGE_BENCHMARK_BASE_URL` repository Secrets, preflights the Provider, downloads original evidence, packages the exact current Forge and runs two cases concurrently at most. Each case runs in a fresh container without host mounts/sockets/SYS_ADMIN, with 6 GiB, two CPUs and a process limit. The shared model budget is 20 minutes/80 turns/200 tools/100k output tokens/$20 configured limit, subject to child designer and standard-review ceilings. Unknown prices do not provide a billing guarantee. Network remains available for Provider communication; this is not an egress-isolated sandbox.

The worker copies only its result/evidence directory out, not the credential-bearing Pi home. The host's temporary model files are deleted in an always step, and each container is removed in finally. Raw evidence artifacts still require allowlist/redaction before public reports. No credential values, endpoints or private local sessions should be published. The GitHub artifact contains the frozen original public issue, including any reporter environment paths; publication summaries redact these separately.

Local no-model preparation validates source/patch/image/grading identity without executing external repository code:

```sh
npm run build
node scripts/swebench-behavior-replay.mjs --case pallets__flask-4045 --source-run ORIGINAL_RUN_ROOT --graded-run REGRADED_RUN_ROOT --output .forge-agent/NEW_PREFLIGHT --prepare-only
```

Actual native execution requires a Linux Docker host and the fixed image/package/credential inputs. Historical labels stay unchanged even if new model checks miss the defect. A successful small synthetic pair or a process exit of zero is not accepted as upstream-quality evidence. New published outcomes must identify workflow run, runtime/harness fingerprints, every fixed candidate, actual assertions/receipts, abstentions and environment limits.

中文：这轮只重放四份真实旧补丁，不重写代码、不偷看官方测试。检查方案在注入补丁前根据原始问题独立产生，命令由 Pi 原生工具实际执行，再经过当前验证和审阅。旧官方标签仅在容器外用于对照；缺环境、缺证据和超预算不算检出缺陷。当前文档描述协议，不预先宣称结果成功。
