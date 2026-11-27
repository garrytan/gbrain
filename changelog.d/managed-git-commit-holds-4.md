**A managed Git removal whose tracking ref git forgot now still pushes, and `gbrain sync status` asks the user in one consistent way.**

<!-- behavior-change: managed_git_pruned_upstream_pushes -->

### Fixed
- A removal (or a page walk, or a conversion apply) on a checkout with a configured upstream but no tracking ref (pruned after a failed push, or never fetched) now runs the guarded push: gbrain asks the remote, scans the range for secrets, then pushes or holds. Before, it decided there was nothing to push and the removal commit stayed on this machine only.
- When the keep-checkout publish child does not report a push, the `push_unconfirmed` message names the exit and a reason code (`exit 1, reason remote_unreachable`) and the command that shows git's own words on the brain host. It no longer copies the child's error text, which can hold a token, a private path or a URL password.
- A checkout whose upstream names no branch (a merge ref under `refs/tags/`, for example) or names a remote with no URL is a push hold with reason `upstream_invalid`. Before, the guarded push could create a branch named after the tag, or push to a local directory with the remote's name.
- `gbrain sync status` uses one rule for asking the user: every listed hold whose fix asks the user (a commit identity, a push conflict or secret-scan hold, a fence hold) sets `needs_human: true` in `--json` and prints `ASK THE USER:` in the text, whatever `Next` is (a recovery record included). The question prints once, on the hold; `needs_human_from` never names a different blocker than `human_reason` does.

### Blast radius
- A target-absent removal, a page walk or a conversion apply on a checkout with a configured upstream and no tracking ref reports `push: committed` (or a push hold) where it reported `push: skipped` or `nothing_to_push`.
- `git_push_holds` in `gbrain sync status --json` and in doctor gains `last_error` (`phase`, `step`, `reason`, or null), and the text line adds `at step <step> (reason: <reason>)`.
- A fence hold or an asking push hold now reads `needs_human: true`, with `needs_human_from.kind` `fence` or `git_push`; the text prints `ASK THE USER:` under the push hold line.
- A `Next` line for a step that asks the user ends with `ASK THE USER first: the question on the hold above.` instead of repeating the question.
- A stored or printed git step outside the known step names reads as `git`.
- With no next step and a hold that asks the user, the text prints `Next: nothing gbrain runs on its own; it waits on the user (ASK THE USER above).` instead of "the source is synced and holds nothing".

### Known, not in this change
- A legacy free-form `line` in a stored Git error can still appear in `gbrain retry-effects --dry-run`, in doctor parked-effects JSON and when an effect row is rewritten.
- Action text flattens newlines in the agent output renderer.
