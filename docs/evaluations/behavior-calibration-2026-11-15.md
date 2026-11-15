# Frozen-check baseline calibration — 2026-11-15

The offline controls show that the three frozen Flask checks fail identically before and after the candidate patch. They therefore provide no useful discrimination for that patch. Astropy and SymPy reproduction checks distinguish their known original defects from the fixed candidates, while their valid boundaries remain usable. Matplotlib has no frozen plan and stays unavailable. This is not a new coding run, defect-detection score or SWE-bench resolution result.

## Protocol and code identity

The [protocol](../behavior-calibration.md) and [frozen manifest](../../evals/swebench-lite/behavior-calibration.json) reuse all four outcomes from model replay 43571025712. No checks, expectations or candidate patches are resampled. The [allowlisted aggregate](behavior-calibration-2026-11-15.json) records source-report, check-plan, command, patch, package, harness and original image fingerprints.

Actions run **43669953603**, code revision **f43482c6ae85b14527d9daaa7b478ce537117729**, completes three baseline/candidate pairs and retains one missing-plan outcome. All six control workspaces remain unchanged. There are 18 real native shell executions, zero new model calls and zero infrastructure failures. The official grader is not run again; earlier official labels/results remain unchanged.

Each target starts in a separate fresh instance of the pinned original task image plus the exact diagnostic package. The unmodified effective HEAD is the baseline; the original fixed patch is applied only in the candidate container. Execution containers have no network, credentials, host mounts/sockets or added capabilities. Image/package preparation happens before offline execution. Commands use the actual Pi 1.4.0 shell implementation programmatically and retain exact exit/output metadata, labeled pi-programmatic-shell. This is distinct from a product-session receipt or a fresh designer/reviewer run.

## Observed comparisons

| Frozen plan | Baseline | Candidate | Interpretation |
| --- | --- | --- | --- |
| Flask B1/B2/B3 | Three failures | Same three failures with identical output hashes | No candidate discrimination |
| Astropy B1/B3 | D-format output incorrectly uses E | Both pass with D exponent text and numeric preservation | Two changed-to-pass observations on this known defect |
| Astropy B2 | Pass | Pass | E-format output preserved |
| SymPy B1 | Reversed syms yields only one tuple | Passes with the complete eight-tuple set | Original reproducer distinguishes these source versions |
| SymPy B2/B3 | Pass | Pass | Quadratic boundary sets preserved |
| Matplotlib | No frozen plan | No replacement plan | Unavailable; no claim about the defect |

The nine comparisons comprise three changed_to_pass, three unchanged_pass and three pre_existing_failure observations. A passing workflow means the diagnostic completed, not that every check is useful. Every row explicitly retains concreteDefectClaimed=false.

Flask B1 and B3 assume that Flask.add_url_rule rejects dotted endpoint names; that baseline assumption is false in the original source. Their failures occur before the requested candidate behavior can be established. B2 reaches the same Werkzeug as_tuple test-client incompatibility in both controls. The exact assertion text and native traces are retained in the aggregate. A baseline failure alone would not identify these causes; the frozen check and actual failure still have to be inspected.

## Engineering change, measured separately

The output-headroom policy is completed at runtime revision **3a6685fea0c91d4e099eaf4ac3b536b58b906882**. It closes evidence collection at the existing ten-read bound or earlier on observed output/turn headroom. Supported Pi OpenAI Completions/Responses requests cap exploration output at 2k and finalization at at most 6k, within smaller remaining local/parent and Provider ceilings. The sole schema correction enters finalization immediately instead of being trapped under the exploration cap again. Other Provider wire formats and ordinary reviewer ceilings are preserved.

Five affected test files pass **82/82** cases at that runtime revision; typecheck, build and clean tarball/CLI installation checks pass. These use a local streaming Provider fixture for native Pi integration, not a measured live-model quality gain. The offline calibration does not execute the updated designer and cannot validate its effect on Matplotlib. The [engineering record](behavior-calibration-engineering-2026-11-15.json) distinguishes these checks, intermediate development failures and remote CI. No new browser acceptance or local full-suite pass is claimed.

## Decision and limits

The diagnostic can now reject the interpretation that the old Flask block was a useful code-defect catch. It also shows that the two correct-candidate plans are sensitive to their known original bugs. It does not repair either historical Flask/Matplotlib miss, establish general check quality or prove the output policy improves real model delivery.

Production behavior has not acquired an automatic baseline execution or automatic check-repair stage. Connecting calibration to production must preserve failures, use bounded correction of demonstrably invalid expectations, and never silently discard failures or change user requirements to obtain green results. Expand the coding ablation only after that path is independently qualified. Prior failed runs stay published.

## 中文

这轮用固定检查做了 18 次真实断网执行，没有新模型调用。Flask 三条检查在基线和候选上全部失败且输出一致，证明此前的阻断没有区分补丁前后。Astropy 两条、SymPy 一条检查能区分各自已知的原始缺陷与正确补丁，其余边界前后通过；Matplotlib 仍因没有冻结方案而不可校准。输出预算收敛修复通过了工程回归，但未取得新的真实模型收益证据。校准目前是诊断能力，还没有自动接入普通用户任务。
