**`gbrain sync status` now says when a source is excluded from automatic sync, so a source that nothing syncs no longer reads like a stuck one.**

### Fixed
- A source with `config.syncEnabled=false` (`gbrain sources set-sync <id> off`) is skipped by autopilot's per-source cycle, the freshness loop and `gbrain sync --all` without a log line, and its status gave no sign of it: a stale source looked parked or stuck. `gbrain sync status` now carries `automatic_sync` (`enabled`, and when it is off a `why` and a `fix` that previews `gbrain sources set-sync <id> on --dry-run`), and the plain-text status prints an `automatic sync: OFF` line. Nothing else about the source's state or `next` changes.

<!-- behavior-change: sync_status_automatic_sync_gst3329 -->
