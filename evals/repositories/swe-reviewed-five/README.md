# Selected five native repository tasks

These pinned public issues are an **experimental evaluation cohort**, not a published five-task score. They are adapted from `SWE-bench/SWE-bench_Multilingual`, dataset revision `846e647b9f33c0b51b739d005d13d85493c9af09` (MIT dataset metadata). The source repositories Axios and Three.js are MIT licensed; reference and test patches retain their upstream code ownership. Sources: [dataset](https://huggingface.co/datasets/SWE-bench/SWE-bench_Multilingual), [Axios](https://github.com/axios/axios), [Three.js](https://github.com/mrdoob/three.js).

| Instance | Focus |
| --- | --- |
| axios/axios #5085 | Set-Cookie header regression |
| axios/axios #5892 | Compression handling |
| axios/axios #6539 | HTTP adapter regression |
| mrdoob/three.js #26589 | Line/Mesh/Points behavior |
| mrdoob/three.js #27395 | Sphere behavior |

The manifest contains immutable commits, native Node-based focused checks, held-out test patches and separate reference patches. Reference patches are used **only** by the model-free validator. Dependency setup avoids changing the lockfile and disables install scripts. No upstream Docker image or official benchmark score is implied; transitive dependency resolution and the host OS remain limitations.

Run `npm run eval:repo -- --suite evals/repositories/swe-reviewed-five/suite.json --prepare` first and review all sources, patches and commands. Then run the model-free validator with `--trust-suite --repeat 3`. Only a complete, matching baseline/reference artifact should enter model comparison. Setup, oracles and tools run with the launching user's permissions.

An earlier **local-mirror** version of this cohort completed three baseline/reference repetitions for two Axios tasks. The third task's checks passed but Windows worktree cleanup failed; the remaining two tasks were not completed. Those failures and the incomplete cohort remain local evidence under a different suite fingerprint. This HTTPS manifest has changed its fingerprint and is **not** relabeled as validated. It deliberately publishes the reproducible inputs without inventing a five-task result.
