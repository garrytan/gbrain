**A full test run whose failed jobs were re-run now still lists every test file it ran, and names the files that passed only on the re-run, instead of recording no files at all.**

### Fixed
- After "Re-run failed jobs" on a full Test or E2E run, `ci-manifest.json` counted every job that passed in the first attempt as stale, so the run's `tree.json` listed no test files and could not be used as evidence for the tree. The manifest now takes each job at its newest attempt, marks the files whose newest result came from the re-run (`rerun` in the manifest, `rerun_files` and `attempts` in `tree.json`), and `tree.json` refuses outright when any job's newest attempt still has a failing test.
- A run whose files passed only on a re-run never clears a failure, so nightly-watch reports it as incomplete evidence and keeps the incident open.
