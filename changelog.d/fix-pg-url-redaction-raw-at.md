---
important: security
---
**Database URLs no longer show part of a password that contains a raw @, and four small date and limit flags now refuse bad values instead of misreading them.**

<!-- behavior-change: pg_url_raw_at_redaction_gst3639 -->
<!-- behavior-change: strict_since_limit_values_gst3639 -->

### Fixed
- A database password containing a raw, unencoded `@` is now redacted whole. The redactor ended the password at its first `@`, while the database driver splits at the last one, so such a URL connected fine and the rest of the password showed after `***@` in `gbrain config get database_url`, `gbrain engine status --json`, `gbrain doctor`, and the init, db-repair and migrate-embeddings notes.
- `--since` refuses a date that is not a real calendar day, such as `2026-02-30`, in `gbrain agent logs`, `gbrain access read-log`, `gbrain beliefs`, `gbrain repair` and `gbrain recall`, and in the recall tool's `since` parameter. Before, the date rolled over into March and the command quietly used another window.
- `gbrain code-callers`, `code-callees`, `code-def` and `code-refs` refuse a `--limit` that is not a whole number of 1 or more, or that has no value, with an `invalid_params` usage error (exit 2). Before, `--limit abc` or `--limit -5` failed with an `unknown` server error, and `5abc`, `0` and `1.5` were quietly misread.
- The `gbrain recall --today` heading shows the local date its window starts on. Before, it printed the UTC date, so in the evening west of UTC today's facts appeared under tomorrow's date.
