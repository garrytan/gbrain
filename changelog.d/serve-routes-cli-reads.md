**Skill scripts can read a PGLite brain while the agent's `gbrain serve` holds it: `gbrain find`, `list`, `search`, `query`, `backlinks`, `waiting` and other everyday reads now go through the running server instead of failing with `pglite_busy`.**

<!-- behavior-change: cli_reads_through_live_pglite_serve -->

### Fixed
- On the default install, `gbrain setup claude-code` (or `codex`) starts a stdio `gbrain serve` that holds the PGLite brain's single-writer lock for the whole agent session, so CLI reads from skill scripts refused with `pglite_busy` and told the user to stop the server. These reads now ask that server, through the same local socket CLI writes already use, and print the same output with the same exit codes as with no server running: `gbrain find`, `list`, `search`, `query`, `get`, `tags`, `links`, `backlinks`, `timeline`, `history`, `graph`, `whois`, `entity`, `search-exact` and `gbrain waiting`. Commands that need the database to themselves (admin commands, migrations) still refuse with `pglite_busy` as before. A server from an older gbrain answers `owner_unavailable` and asks for an upgrade and restart.
