# Public web and empty verification regression — 2026-11-10

The reported user failure was reproduced from the local task journal: a model called run_verification in a project with no checks, leaving a false empty report. A later host check changed the status to skipped without clearing that report, and completion stayed at needs_attention/verify. The user's recorded budget was not exceeded. Private conversation text, paths and provider configuration are excluded here.

The fix canonicalizes empty verification for model and host paths. It does not call an unconfigured check a passing test. A separate Pi hook fills a missing native shell timeout with 120 seconds, preserving explicit long-command timeouts and Pi process ownership. Public web search and URL reading are registered as Pi extension tools.

## Real-model protocol

- DeepSeek V4.1 Flash, medium reasoning, explicit planned workflow.
- An isolated ordinary directory with a pre-existing notes.txt. No verification configuration and no Git repository were added.
- Ask the model to search for Three.js official documentation with web_search, read https://threejs.org/docs/ with web_fetch, create index.html as a self-contained animated SVG pelican on a bicycle within 160 lines, preserve notes.txt, call run_verification without adding config, and deliver a Chinese file/opening summary.
- Fixed ten-minute evaluator deadline. Provider credentials/catalog are copied only to a temporary private home; no user's existing task is resumed or modified.
- Eight target gates: host completion, explicit unconfigured verification without an empty report, successful search, successful URL read, successful no-op verification tool, an HTML file with SVG/animation markers, unchanged notes.txt, and task-index agreement.
- This checks execution and the reported completion boundary. SVG markers do not prove animation quality, leg geometry or visual correctness. No visual-quality score is claimed.

## Retained outcomes

| Run | Observed result | Elapsed | Meaning |
| --- | --- | --- | --- |
| Initial diagnostic | Failed at fixed ten-minute deadline | 10 min | Search/read and HTML write succeeded. A model-generated multi-line Python shell command never returned; it omitted a command timeout. Final gates were not reached. |
| Revised build | Passed all 8 gates | 191.4 s | Search/read, SVG file, no-op verification and final host/index state agreed. 16 model turns, 16 tool calls, 294,580 cumulative request tokens. |

The [allowlisted JSON](network-empty-verification-2026-11-10.json) keeps both code fingerprints and dates. Each fingerprint hashes the ordered UTF-8 path names and file bytes listed in fingerprintFiles using SHA-256. These are selected-source fingerprints, not a clean Git revision. The revised run used a shell-timeout hook and its guidance; two different builds and one repetition do not isolate the benefit of that hook or prove general stability. Unknown provider pricing stays null.

Direct public-network probes also read Three.js documentation, MDN and npm metadata, and returned real search sources from Yahoo. Bing's regional redirection resolved to a local address on this machine and was refused; DuckDuckGo returned a challenge. These failures led to an accessible default search source with honest fallback errors. Public search availability remains site-dependent.
