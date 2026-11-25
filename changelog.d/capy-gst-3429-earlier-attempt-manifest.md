**A full CI run still counts as test evidence for `/ship` after you re-run just one failed job.**

### Fixed
- After `gh run rerun --job` re-runs one failed job, the full-suite record now keeps the list of test files the run executed, so `/ship` can reuse the run instead of refusing it with `CI_CARRY no_tests`. The record now accepts the run's execution manifest from an earlier attempt of the same run and commit, as long as the job that writes the manifest succeeded. A manifest from a newer attempt, another run or commit, an incomplete manifest, or one that lists a failing test is still refused.
- The E2E execution manifest now waits for the Postgres 15 and OpenClaw jobs too, so re-running either one rebuilds the manifest instead of reusing the earlier attempt's.
