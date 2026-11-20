**Search no longer shows an outdated page as current without saying so: a failed supersession check is reported, and a new `supersedes` link applies to the next search.**

<!-- behavior-change: search_supersession_currency -->

When the supersession check fails, search and query now return the degraded marker `supersede_check_failed` instead of an unmarked ranking, and a `supersedes` link written while a server runs is seen at once.

### Fixed
- When the check for pages a newer page replaced fails (statement timeout, dropped connection), in the ranking or in the top-slot lookup for a slug-shaped query, `search` and `query` now report the degraded stage `supersede_check_failed` (reason `timeout` or `provider_error`) in `_meta.degraded`, and the CLI and MCP notice says results may include outdated pages. Before, the outdated page ranked first with no `superseded` flag and no marker. A brain that has no links table yet still answers as before.
- A long-running `gbrain serve` no longer keeps showing an outdated page as current for up to 5 minutes after the first `supersedes` link is added. Only a positive "this brain has supersedes links" answer is remembered, so a link written by this process or by another one reaches the next search.

### For contributors
- `supersede_check_failed` is a recall-affecting stage (not in `RANKING_ONLY_DEGRADED_STAGES`): a failed check is transient, so a degraded result takes the short cache TTL and the next query can re-check. `runPostFusionStages` takes the response's degraded list as an optional fourth argument.
- Engine parity: `supersedingPageSlugs` is held on every arm to reject a read it cannot run (never an empty map) and to see a link written after an empty answer; the Rust arm stops on its typed refusal of a non-integer page id.
