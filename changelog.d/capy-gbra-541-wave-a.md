**A batch of small fixes: folder attach retries, dropped webhook events, cut-off stdio replies, and clearer help and doctor text.**

### Fixed
- Retrying a managed folder attach with the same `--request-id` replays the first attempt's default-search choice instead of failing with `idempotency_conflict`.
- Two different GitHub events on one item within 30 seconds are both processed; a redelivery of the same event is still deduplicated.
- Local `serve` and the thin-client bridge deliver a large stdio reply in full when stdin closes right after it.
- Atoms stamped by `repair visibility` can be adopted by a later generation again, without widening their visibility (#9386).
- A migration that keeps failing gets the `migrations_pending` notice with the `apply-migrations --force-retry <version>` step.
- Doctor's `derived_visibility` check counts only active sources, so it no longer suggests a repair that finds nothing.
- `repair purged-page-facts`: a preview that approves nothing prints an apply command that reports nothing to do.
- A DNS failure on a Supabase pooler URL points at this machine's DNS and network instead of a paused project (#8531).
- `sources status --json` prints each held file's fix with the `--brain` pin, so it runs as written (#9319).
- A hosted install asking setup for the skill resolver is told the command that works without a local brain (#9245).

### Changed
- `gbrain setup codex` and `--remove` keep a `.bak.<timestamp>` copy of each `config.toml` or `hooks.json` they change and print its path.
- `gbrain setup codex` prices the search-mode cost matrix with OpenAI models.
- `embed --help` names the `--stale --facts --source <id>` form for facts saved with `remember`; `upgrade --help` no longer mentions a postinstall step; doctor's consent wording says gbrain makes no provider request on its own.
- The enrich skill says to leave out empty sections instead of writing `[No data yet]` (#7061).

<!-- behavior-change: setup_codex_backups_gst2779 -->
