---
kind: fix
---
`gbrain doctor` sync_freshness no longer fails a connector source whose first sync is still in progress. A source whose last sync stopped only at a provider usage or rate limit (gbrain.io's daily allowance, Google's quota) with nothing else failed, and whose limited runs landed pages inside the fail age, now reads `warn` (`sync_usage_limited`) and says the next sync resumes it. A source whose sync job is running now reads `warn` (`sync_first_run_in_progress`) even when no sync lock is held at that moment. Failed items, held files, a bare permission error (403) and limited runs with no pages landed inside the fail age still read `fail` (`sync_no_successful_sync`).
