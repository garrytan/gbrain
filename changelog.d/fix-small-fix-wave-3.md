**Doctor, init, call import and gbrain serve report and record the right thing in seven small cases.**

### Fixed
- `gbrain doctor`'s grant check is ok when the only operations a grant misses are ones the owner adds by name, and its message names them with the command that adds them.
- `gbrain import --calls` finds a call already imported from any folder above the one you import, and reports a call whose page is still being written as pending instead of writing a second copy; with `--accept-pending` it still exits 10 when that write waits on a stale owner host.
- A folder whose `.git` is an empty file is no longer taken as a git checkout.
- Release notes drop a trailing internal issue code, like `(ABC-12)`, from each line of the change list.
- `gbrain init --force --embedding-model <model>` records the new model and width in the database as well as the config file, so the two agree (#9451).
- `gbrain serve` names upgrade migrations that haven't run, once at startup on stderr, and `gbrain doctor` reports them too, also on a brain an older release last opened whose local upgrade ledger is empty.

### For contributors
- The key-files page `google-and-loops.md` was at its 60,000-byte cap, so its harness and MCP entries moved unchanged to `google-and-loops-more.md`; the Google source entry now says what an unmanaged `--dry-run` returns.

Reported by @Loprz (#9451).
