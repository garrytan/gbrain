**A large source whose sync keeps stopping at its run limit now finishes catching up instead of being reported as abandoned.**

### Fixed
- A sync pass that saved at least one page or hold before its run limit stopped it now counts as progress, so `gbrain sync status` and `gbrain doctor` no longer report `pass_abandoned` for a source that is still moving. A pass that saved nothing still counts toward the abandoned streak, and the open pass row shows how many entries it has settled so far.
- On a read-only mirror, a page you edited in gbrain whose file is gone upstream is kept as a database-only page. Sync results and status report these as `carried` instead of listing them as holds to fix, and no command advises `--prefer database` on a mirror, since gbrain never writes a mirror's files.
- A symlink whose target does not exist is skipped and counted (`skipped.symlink_dangling`) instead of held as an unreadable file, and an older hold for one is released. A dangling link at a path that still has a live page stays held, and so does a committed file whose working copy alone was replaced by a dangling link.
- The commit notifier no longer starts a sync for a source with sync turned off (`config.syncEnabled=false`). Turning sync back on makes the notifier watch it again.

<!-- behavior-change: notifier_sync_disabled_gst2515 -->
