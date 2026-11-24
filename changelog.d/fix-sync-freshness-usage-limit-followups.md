**Doctor keeps the "first sync stopped at a usage limit" warning through frequent reruns, skipped and queued runs, and limits hit before any mail is read.**

<!-- behavior-change: sync_freshness_usage_limit_followups_gst3452 -->

### Fixed
- Doctor's `sync_usage_limited` warning for a connector source in a long first sync now holds while the newest limited run that landed pages is inside the fail age, however many later runs hit the spent limit (it read only the last 50 jobs before), and a skipped or queued newest job no longer hides it. A run whose writes are still pending no longer counts as having landed pages.
- A gbrain.io usage limit hit while reading the account's identity, before any mail, now ends the run `partial` with `stopped_on: usage_limit` instead of failing the sync.
- A bare permission error (HTTP 403) on one Gmail thread no longer stops the rest of the batch as if a usage limit were spent, and the log no longer calls it rate limited.
- A sync job that keeps its job lock but has run past the staleness ceiling now reads `fail` with a read-only `gbrain jobs get` fix instead of "first sync running".
