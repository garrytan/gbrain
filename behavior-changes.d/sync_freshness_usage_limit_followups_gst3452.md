---
kind: fix
---
`gbrain doctor` sync_freshness keeps the `sync_usage_limited` warning for a connector first sync through any number of reruns that hit the spent limit, and through skipped or queued runs, while a limited run that landed pages is inside the fail age. A run with writes still pending no longer counts as landing pages. A sync job that holds its job lock but has run past the staleness ceiling now reads `fail` (`sync_no_successful_sync`) with a `gbrain jobs get` fix instead of `sync_first_run_in_progress`.
