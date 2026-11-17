**`gbrain dream --input` with no database now fails instead of reporting success, a second dream run on the same day keeps the first run's summary links, and Slack day pages pick up a missing user's name within a day.**

<!-- behavior-change: dream_named_phase_no_database_9608 -->
<!-- behavior-change: dream_summary_keeps_earlier_runs_9598 -->
<!-- behavior-change: slack_missing_user_daily_relist_9601 -->

### Fixed
- `gbrain dream --input <file>`, or `gbrain dream --phase <name>`, with no database connection exited 0 after the phase it was asked to run skipped. A phase you named (or that `--input` implies) that skips for want of a database now ends the command with `database_error` (exit 1, the error envelope under `--json`). A plain `gbrain dream` names no phase and is unchanged. Contributed by @Masashi-Ono0611 (#9613, fixes #9608).
- The dream summary page is one page per date, but each synthesize run rebuilt it from its own pages, so a second run on the same day dropped the first run's links. It now keeps earlier links that still point at a live page. "Pages written" still counts this run, and a new "Pages from earlier runs today" line counts the pages it kept. First fixed by @Masashi-Ono0611 in #9602 (fixes #9598).
- A Slack user missing from the last users listing (a new member, or a Slack Connect user from another workspace) was shown by raw id on day pages for up to seven days. Once the listing is a day old, the next sync that renders such a user lists the workspace again, so a new member's name shows up within a day. A Slack Connect user never appears in the listing, so a workspace with one costs at most one extra listing a day. First fixed by @Masashi-Ono0611 in #9605 (fixes #9601).
- A rerank test that freed its unreachable port before running could fail when another process took the port; it now holds the port for the whole run.

Contributed by @Masashi-Ono0611
