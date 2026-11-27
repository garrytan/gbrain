**`gbrain sync status` now shows managed Git commits that keep failing, with the git step and a reason code.**

<!-- behavior-change: managed_git_commit_holds -->

### Added
- `gbrain sync status` lists Git effects whose commit was not made (most often a checkout with no Git identity): `git commits held: N retrying, M parked (git_unavailable) at step commit-tree (reason: identity_missing)`, and `Next:` names the fix. When this host owns a checkout with no identity, the fix is a question for the user (`ASK THE USER:` in the text; `needs_human: true` in `--json`). `--json` gains `git_commit_holds`, an additive field (each hold: counts, codes, the failed step, a reason code from a fixed list, `identity_missing` and `owner_host`); `git_push_holds` is unchanged.
- A managed Git effect that fails keeps only the failed git step and a reason code (`last_error`: `phase`, `step`, `reason`). git's own error text is never stored or printed, because a filter, hook or credential helper can print a token, a private path or a URL with credentials.
- The identity fix quotes the checkout path for the shell, so a path with a space or a shell character pastes safely.

### Blast radius
- A git step that does not finish during the push (a timeout or a spawn error), after the local commit landed, is now recorded as `git_push_unavailable` (a push hold, retried with `--parked-pushes`) instead of `git_unavailable`.
- A retried removal whose upstream git cannot read (for example a damaged tracking ref) now stays a push hold and retries, instead of completing with its removal commit unpushed. A checkout with no upstream still completes as before.
- When several page files commit in one pass and git cannot tell whether a removal still owes a push, only that removal is held; the other files still commit and push.
- On a Rust brain, `gbrain sync status` now reads Git holds at all: push holds (`git_push_holds`) appear there for the first time, as on PGLite and Postgres.
- `gbrain engine swap --to rust --plan` names the managed-mode known loss (a failing Git effect refuses `raw_sql` on a Rust brain) for every managed brain, not only with the multi-user switch on.
