**`gbrain sync status` now shows managed Git commits that keep failing, with the git step and its first error line.**

<!-- behavior-change: managed_git_commit_holds -->

### Added
- `gbrain sync status` lists Git effects whose commit was not made (most often a checkout with no Git identity): `git commits not made: N retrying, M parked (git_unavailable) at step commit-tree: "Author identity unknown"`, and `Next:` names the fix. `--json` gains `git_commit_holds`, an additive field (each hold: counts, codes, the failed step with git's first error line, secrets removed, and `identity_missing`); `git_push_holds` is unchanged.
- A managed Git effect that fails keeps the failed git step and git's first error line (`last_error`), after one sanitizer removes URL credentials, tokens and Authorization values.

### Blast radius
- A git step that does not finish during the push (a timeout or a spawn error), after the local commit landed, is now recorded as `git_push_unavailable` (a push hold, retried with `--parked-pushes`) instead of `git_unavailable`.
- On a Rust brain, `gbrain sync status` now reads Git holds at all: push holds (`git_push_holds`) appear there for the first time, as on PGLite and Postgres.
- `gbrain engine swap --to rust --plan` names the managed-mode known loss (a failing Git effect refuses `raw_sql` on a Rust brain) for every managed brain, not only with the multi-user switch on.
