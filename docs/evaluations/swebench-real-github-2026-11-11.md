# First GitHub real-model SWE-bench attempt — 2026-11-11

This is a retained failed run of the first real-model GitHub Actions workflow. It is useful evidence about the evaluation boundary, not a model score.

## Run

- GitHub Actions run: `43049931878`.
- Code revision: `423a05cfc1b3153ed4dfd7f9560abe6b22177a60`.
- Model: `deepseek/deepseek-v4.1-flash`, medium reasoning, Direct.
- Frozen tasks: 3.
- Official baseline/reference validation: **3/3 valid**.
- Official harness commit: `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e`.
- Cohort fingerprint: `77e014b58128de98ae1e1c9d566bf870f12da4183556affcbaa64e558b80d0af`.

Docker, the task images, the official harness, baseline/reference grading and Forge container startup all worked. Each Forge worker then failed before making a model request because the configured Provider returned:

```text
403: Your IP address is not allowed
```

The three workers made zero tool calls and consumed zero model tokens. Their patches were empty. The official grader therefore saw unresolved empty patches, but these rows must be treated as **infrastructure failures**, not model-quality failures.

## Corrected reporting boundary

The original run used the first version of the real workflow, which did not propagate a failed Forge task's final error into the evaluator result. The current code records the session failure and stops before official grading when a Provider or Forge execution error is present. Such a row has:

```text
official_resolved = null
accepted = false
false_completion = null
infrastructure_failure = true
```

The failure classification fix is covered by the SWE-bench protocol regression suite and will be included in the next GitHub run. The model-quality denominator must begin only after the Provider accepts requests from the runner environment.

## Required follow-up

The repository Secret `FORGE_BENCHMARK_BASE_URL` currently points to a service whose IP policy rejects GitHub-hosted runners, or the associated key is restricted to an allowlisted source network. Use a Provider endpoint and key that permit the GitHub runner, or run the workflow on a self-hosted runner inside the allowlisted network. Do not publish the key or endpoint in the repository.
