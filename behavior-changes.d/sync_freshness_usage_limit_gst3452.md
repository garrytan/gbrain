---
kind: fix
---
`gbrain doctor` sync_freshness no longer fails a connector source whose first sync is still in progress. A source whose last sync, inside the fail age, stopped only at a provider usage or rate limit (gbrain.io's daily allowance, Google's quota) with nothing else failed now reads `warn` (`sync_usage_limited`) and says the next sync resumes it. A source whose sync job is running now reads `warn` (`sync_first_run_in_progress`) even when no sync lock is held at that moment. A run that landed nothing, failed items, held files and a last attempt older than the fail age still read `fail` (`sync_no_successful_sync`).
