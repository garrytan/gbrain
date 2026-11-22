**gbrain's opt-in telemetry now has a locked-down home: its own tables and two functions in a shared Supabase project, ready to apply.**

### Added
- `supabase/gbrain-telemetry/` holds the SQL and the two Supabase functions behind opt-in telemetry. Nothing in the gbrain CLI sends anything yet; the client arrives in a later release, off by default.
- The public key that ships with gbrain can read and write nothing. Every table is row-level locked with no policies, and only the ingest function writes.
- The ingest function checks every field against fixed lists and drops anything else, so free text, page names and paths never reach a table. It accepts at most 15,000 requests and 150,000 rows a UTC day and answers 429 above that. `forget` stays outside that limit, so a flood can't block a user's withdrawal.
- The pulse function publishes counts only, cached for an hour. It always includes the newest release, ignores versions newer than the latest release, and answers stale or 503 instead of zeros when it can't compute.
- `verify.sh` checks a deployment: every table, the view and every function refuse the public key and signed-in users, the ingest stores one test event, and the pulse answers.
