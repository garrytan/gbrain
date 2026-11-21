**A source set to `gbrain sources set-sync <id> off` is no longer synced by `gbrain dream` or an autopilot cycle; only an explicit `gbrain sync --source <id>` syncs it.**

### Fixed
- The dispatchers already skipped a source with `config.syncEnabled=false`, but the maintenance cycle's own sync phase did not. So `gbrain dream --source <id>`, which doctor's `cycle_freshness` fix suggests, still synced the source, and so did an autopilot-cycle job whose phases name sync. For a Google source that resumed a paused contacts re-list and wrote pages while sync was off. The cycle now skips the phase as `sync_disabled` and names the explicit command. Lint, backlinks, extract and the freshness stamp still run.
- Doctor's `cycle_freshness` check lists a source with sync off as "sync off" instead of stale or failing, and never names it in its `gbrain dream --source <id>` fix. Before, a never-cycled source with sync off read as the stalest source, so a scheduled job that cycles the stalest source picked it.

<!-- behavior-change: cycle_sync_off_skipped_gst3337 -->
<!-- behavior-change: cycle_freshness_sync_off_gst3337 -->
