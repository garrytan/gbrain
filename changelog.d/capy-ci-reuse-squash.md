**A squashed landing on master reuses the pull request's passed full test run instead of running the whole suite again.**

### Changed

- `scripts/ci-reuse.ts`: a one-parent push to master (a pull request landed as one squashed commit) now reuses the complete, passed full run of Test or E2E whose head has the same tree, under the same artifact, job and repository checks a merge commit gets. Such a push has no merged head, so it looks up the landed pull request's head by commit, adds the heads of recent runs with the same tree, reads every run on those heads, and the newest one decides: if it failed or is still running, the push runs in full, and a cancelled run or one that skipped its full job is passed over. A one-parent push whose tree matches no full run, and a root commit, still run in full. docs/ci-event-parity.md, "Master-push reuse", says so.
