**`gbrain sync` now prints a notice and includes `deletes_withheld` in `--json` when a managed pass withholds deletes under a delete cap or the 50% valve.**

### Fixed
- When a managed `gbrain sync` hits the 50% mass-delete valve, `sync.max_deletes` or `sync.max_delete_ratio`, the human output now prints one line naming the withheld count, which limit tripped and the next commands (in single-source, `--all`, delegated and watch runs; watch mode prints it once when the set first appears), instead of printing only `-0 soft-deleted` or `Already up to date.`.
- `--json` sync envelopes now carry `deletes_withheld` with the withheld record, `newly_withheld` and status's next action (`fix`). Exit codes and `sync_status` are unchanged.

<!-- behavior-change: sync_reports_withheld_deletes -->
