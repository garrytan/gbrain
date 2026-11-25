**`gbrain setup` now offers to import your recent coding sessions, so a new brain remembers your work on day one.**

### Added
- On a brain it just created, `gbrain setup claude-code` and `gbrain setup codex` preview the Claude Code, Codex and OpenClaw sessions on the machine and offer to import the newest one, then the rest of the last 30 days on a second yes. Off a terminal the offer is the `setup_history` decision (`gbrain setup <harness> --history-decision <id>`). New flags: `--history none|decline|latest|<1-30>`, `--history-dir`, `--no-extract`. Nothing is imported without a yes, nothing calls a model, and the archive switch is never changed.
- After an import setup prints a card: conversations, projects and links, each marked measured, off or unavailable, and three questions built from your own sessions. `--json` carries it under `history`.
- `gbrain transcripts archive setup-import receipt|preview|run|decline|card` runs the same steps by hand. New error codes: `setup_history_ineligible`, `setup_history_decision_expired`, `setup_history_decision_unavailable`, `setup_history_failed`.

### Fixed
- The setup history import checks the brain's audience before each day it publishes, so a member added mid-run stops it with `archive_audience_changed` instead of publishing pages with no readers.

<!-- behavior-change: setup_history_import_offer -->
<!-- behavior-change: archive_stops_on_audience_change_setup -->
