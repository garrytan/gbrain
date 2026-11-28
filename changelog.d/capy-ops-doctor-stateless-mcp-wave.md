**`gbrain config get` prints a known switch's default instead of "not found", writer status shows whether the write owner is alive, doctor stops counting sync failures a later write already settled, and two random test failures are fixed.**

### Fixed
- `gbrain config get` on a registered key that nothing sets now prints the value in effect and says where it comes from, for the write switches (`persistence.single_consumer` and the rest), the preparation budgets and the terminal-failure thresholds. `persistence.single_consumer` prints `false` and exits 0, with stderr naming the built-in default, or the `GBRAIN_SINGLE_CONSUMER` override when one is set. A known key with no built-in default still exits 1, now saying it is a known key, and an unknown key is unchanged.
- `gbrain sources writer status --json` no longer prints a worktree's claim stamp as if it were a heartbeat. Each worktree now carries `owner_live` (a consumer of the owner host renewed its heartbeat recently) and `owner_last_active` (the owner's newest heartbeat or committed receipt), and the raw column is renamed `owner_stamped_at`, since it changes only when a host claims the worktree or a consumer stops cleanly. The troubleshooting table has a row for it.
- Doctor's `persistence_terminal_failures` and `gbrain sources writer failures` count a refused managed-sync page import or delete as settled once any later write of the same page commits, such as the sync that imported the file again. Before, a burst of such refusals stayed unresolved for the whole window and kept the spike warning on after its fix ran. The 24-hour and daily counts behind the spike leave out rows a later request superseded.
- On a stdio MCP server, `request_tools {surface}` now tells a client that opens a new session for every call (or never re-reads tools/list) that it keeps the wider tools only when gbrain is registered with them, with `--surface <surface>` or `GBRAIN_SURFACE` and no `--advertise`. Widening on stdio stays session-only, since stdio has no client identity to save it under. An OAuth client's widening already reaches every later session of that client, and a new test pins it.
- Two tests that failed at random under load now wait on the right event. The import-provenance test compared against `HEAD`, which the managed Git commit moves on its own schedule, and the suggestion-deadline test started its 60 ms deadline before the existence check had answered.

### Changed
- Docs. The doctor registry entry in the key-files index now counts 182 checks and lists `schema-pack-active.ts`.

<!-- behavior-change: config_get_unset_default_gst3449 -->
<!-- behavior-change: writer_status_owner_liveness_gst3519 -->
<!-- behavior-change: terminal_failures_sync_superseded_gst3450 -->
