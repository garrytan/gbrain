**A keyword search that timed out on a cold Postgres cache comes back within about a minute instead of ten.**

### Fixed
- After hybrid search's keyword statement hits the keyword statement timeout, `gbrain serve` and MCP sessions still skip that exact statement (`keyword_arm_failed: skipped_after_timeout`), and now also re-run it once in the background 30 seconds later, then after 60, 120 and so on seconds while it keeps failing, never past `search.keyword_timeout_negative_cache_seconds` (default 600, unchanged). The first re-run that answers ends the skip. A re-run uses the same statement, scope and bound, starts only when the pool has an idle connection, runs one at a time per brain, throws its rows away, writes no timeout counter row and is not recorded as a search. Before, one timeout on a cold cache left every identical search keyword-less for ten minutes even after the cache had warmed (#7082).

<!-- behavior-change: keyword_skip_rerun_7082 -->
