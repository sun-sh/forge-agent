# Direct SWE-bench Lite baseline and freshness repair — 2026-11-12

This report records the first five-task Direct baseline on the official GitHub workflow and the targeted Astropy rerun after repairing Git submodule evidence. It is a small cohort result, not a full SWE-bench Lite score.

## Five-task Direct baseline

GitHub Actions run [43151239729](https://github.com/sun-sh/forge-agent/actions/runs/43151239729) ran five frozen Lite-20 tasks, three repetitions each, for 15 real DeepSeek `deepseek-flash` executions. The evaluated Forge revision was `03d75c28b246e6b84bd3f1148c92a4c085a87501`, before the Git submodule evidence repair.

| Metric | Result |
| --- | ---: |
| Baseline/reference validation | 5/5 |
| Scheduled executions | 15 |
| Officially evaluated | 12 |
| Official resolved | 6/12 |
| Forge accepted | 6/12 |
| False completions | 6/12 |
| Infrastructure failures | 3/15 |
| Total tokens | 10,709,014 |
| Output tokens | 216,404 |
| Median execution time | 107.9 s |

The three infrastructure failures were all Astropy freshness failures. The model changed the intended source file and passed the configured syntax check, but the workspace observer treated a Git submodule structure as an unconfirmable nested repository. Flask produced three false completions: Forge completed and passed its visible check, while the independent official grader reported `resolved: false`. Scikit-learn and SymPy were accepted in all three repetitions.

This baseline therefore demonstrates two separate product problems: false completion remains substantial on this small cohort, and workspace evidence can still remove otherwise gradeable tasks when repository structure is complex.

## Astropy repair rerun

GitHub Actions run [43162856637](https://github.com/sun-sh/forge-agent/actions/runs/43162856637) reran Astropy three times after commit `5f9fab1ace81f105b2b6f74c1e7df33924ba3e2c`. The change records Git submodule entries as opaque gitlink metadata instead of entering the nested repository.

| Metric | Result |
| --- | ---: |
| Validation | 1/1 |
| Scheduled executions | 3 |
| Officially evaluated | 3 |
| Official resolved | 3/3 |
| Forge accepted | 3/3 |
| False completions | 0 |
| Infrastructure failures | 0 |
| Total tokens | 2,882,781 |
| Output tokens | 43,121 |
| Median execution time | 171.5 s |

The targeted rerun confirms that the freshness failure was caused by evidence collection, not by an inherent inability to run Astropy tasks. The full five-task baseline should be rerun after this repair before publishing a corrected aggregate; the prior 6/12 result remains retained under its original code fingerprint.

## Interpretation

The current next quality target is false completion. The Direct baseline has six false completions among twelve officially assessed runs, while the Astropy repair removes the known infrastructure blockage. Planning and independent review should be compared only after the corrected Direct baseline is complete on the same task cohort and code revision.

The machine-readable raw reports remain in the local evaluation artifact directories. Published documentation omits credentials, endpoints and local paths.
