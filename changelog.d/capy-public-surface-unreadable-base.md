**The public-surface check no longer passes silently when it cannot read master's copy of a file it compares with.**

### Fixed
- After a shallow CI checkout is deepened with `--filter=blob:none`, `bun run check:public-surface` fetches file contents at the merge base on demand. When that fetch failed, it read master's manifest as missing and skipped the removal check. It now tells a file that is missing on the merge base from one it could not read. Under `CI=true` it fails with git's own error, and locally it skips.
- A file already on master whose name git quotes (one with non-ASCII characters) now counts as on master, so an old `changelog.d` waiver no longer covers a new golden change.
