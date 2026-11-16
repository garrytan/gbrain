**The public-surface check no longer fails with "no merge base … even after deepening the clone" on shallow CI checkouts whose head is more than one commit past master.**

### Fixed
- `bun run check:public-surface` deepened a depth-1 CI checkout with `--filter=tree:0`, which GitHub's server fails on for a shallow clone that is not partial. It now deepens with `--filter=blob:none`, and when a fetch fails it prints git's own error under the FAIL line.
