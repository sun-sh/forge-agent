# DeepSeek V4.1 Flash clean ablation — 2026-11-11

This report records a fresh real-model run on the current Forge revision. It is a controlled engineering evaluation of the three execution paths, not a SWE-bench score or a comparison with Claude Code, Codex or OpenHands.

## Protocol

The batch used five hand-authored miniature repository tasks:

- inclusive numeric clamping;
- strict port parsing;
- stable deduplication;
- cross-file configuration normalization;
- root-safe path resolution.

Each task ran three times through each arm, for **45 real DeepSeek V4.1 Flash executions**:

- `direct`: adaptive execution;
- `planned`: explicit planning, implementation, verification and independent review;
- `planned-no-review`: evaluator-only ablation of the reviewer.

Every run started from a fresh project and isolated Forge home. The same counterbalanced schedule and budget were used for all arms: 10 minutes, 80 model turns, 160 tool calls, 40,000 generated tokens and a configured USD 30 ceiling. The model catalog did not provide usable prices, so cost is recorded as unknown rather than zero.

A run counted as passed only when all four gates passed: held-out external assertions, current host verification, protected-file integrity and completed host task state. The no-review arm is available only to the evaluator; production requests cannot disable the review gate.

## Results

| Arm | Passed | False completions | Infrastructure failures | p50 execution | p95 execution | Total tokens | Output tokens | Model requests | Tool calls | Review calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| direct | 15/15 | 0 | 0 | 31.2 s | 63.1 s | 620,603 | 23,318 | 100 | 120 | 0 |
| planned | 15/15 | 0 | 0 | 75.8 s | 129.7 s | 1,392,879 | 84,273 | 184 | 252 | 15 |
| planned-no-review | 15/15 | 0 | 0 | 46.8 s | 81.9 s | 1,087,091 | 52,233 | 136 | 170 | 0 |

The planned arm used 15 independent reviewers. None requested a repair, and none needed a format retry. The evaluator recorded 542 tool calls and 3,100,573 total tokens across the batch. Dollar cost remains unknown because the selected catalog entry did not include prices.

## Interpretation

This batch found **no quality or false-completion benefit** from planning or independent review: all three arms passed all 15 runs. The extra stages did have a measurable cost. The planned arm's median execution time was about 2.4 times direct, and its token total was about 2.2 times direct. The planned-no-review arm was also slower and more expensive than direct, while avoiding the reviewer calls.

For this task class, the result supports keeping adaptive execution as Forge's default and asking users to select planning when the additional task ledger, phase visibility or review evidence is worth the overhead. It does not show that review is useless on difficult work; this suite is small, deterministic and substantially easier than a large upstream repository issue.

The next meaningful quality test is the prepared SWE-bench Lite pipeline on a Linux/Docker host with the same model and a fixed budget. That evaluation must report official resolution separately from Forge completion, protected-file integrity and infrastructure failures. The current batch must not be presented as a SWE-bench result.

## Identity and retained evidence

- Model: DeepSeek V4.1 Flash, medium reasoning effort.
- Suite: `forge-eval-small-repo-v6`, fingerprint `038cbefa1a6e76c2`.
- Harness fingerprint: `c2bbf58ad5a52c6fe8aa034f192db065b01f382aa3b22b03caf2b131f9115e56`.
- Forge revision: `96e586a8cf5cfb428c745dc7bded4e0dc37972ec`.
- Environment: Windows x64, Node.js 24.19.0, Pi 1.4.0.

The public aggregate is also available as [machine-readable JSON](deepseek-current-ablation-2026-11-11.json). Per-run evidence remains retained locally; the published files omit credentials, provider endpoints, transcripts and user-specific paths.
