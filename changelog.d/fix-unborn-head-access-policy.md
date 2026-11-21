**A brain made with `gbrain init --git` no longer locks remote readers out on its first sync, before anything is committed.**

### Fixed
- On a Git repository with no commit yet, the first `gbrain sync` took the missing history for a partial clone and marked the whole source as readable by nobody, so every remote read returned `access_policy_pending` until something was committed. The sync now treats a repository with no commit as having no folder rules to apply, so remote reads work from the first day. A source an older release already marked is cleared by the next `gbrain sync --source <id> --no-pull`, with no commit needed.
- `gbrain sync` on a repository with no commit yet now reports it up to date instead of failing with `internal_error` (`rev-parse HEAD`). Pages sync from the first commit on.
- `gbrain access rule add` and `import` on a repository with no commit yet no longer refuse with `access_policy_history_unreadable` that blamed a partial clone.
- Folder rules a source already enforces stay enforced when its branch has no commit (an orphan branch): removing them is still held for `gbrain access apply`, and no page is deleted.
