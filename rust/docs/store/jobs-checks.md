# The brain store: doctor job checks

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Ten typed reads over `minion_jobs` that the doctor, the dream breaker, the global-maintenance stall check and
the dead-write retry used to run as raw SQL. They live with the jobs family (see [jobs.md](jobs.md)): same
keys, same rows, no new record kind. The SQL engines run the statements in `src/core/engine-sql/jobs-checks.ts`
(one text for PGLite and PostgreSQL); the store module is `rust/crates/gbrain-store/src/jobs/checks.rs`, and
the TypeScript members are `src/core/rust-engine/store-members/jobs-checks.ts`. Every member is a read: it
changes no row. Timestamps cross the binding as ISO strings and come back as the same text or `Date` the SQL
engines return for that field.

| Member | Reads |
| --- | --- |
| `listStalledEmbedBackfillSources()` | the `data.sourceId` of every failed or dead `embed-backfill` job whose progress carries a `stall` record, each once, in byte order; a job with no `sourceId` yields `null`, which sorts last |
| `readGlobalMaintenanceDeaths({ deaths })` | the last `deaths` finished `autopilot-global-maintenance` jobs (newest first), and the dream phases whose last `deaths` children all died at their timeout |
| `readLastFailedGlobalMaintenanceJob(since)` | the newest maintenance job that ended without completing after `since` (a `Date#toISOString` text, or `null` for all), and how many did |
| `listFactsAbsorbJobsStillDead({ hours, limit })` | dead or failed `facts-absorb` jobs finished inside the window with no later job for the same page completed, newest first, and the full count |
| `readLegacyJobAuthority()` | the live jobs whose submission authority is not the application authority, the first ten active ids, and the keyed terminal rows with a NULL authority |
| `readQueuedSpendRows({ legacyPrefixes, waitMs })` | queued jobs counted by name and spend basis (a recorded kind, a legacy key prefix of the right name, or unrecorded), and the spend-authorized rows waiting longer than `waitMs` |
| `listBuildSkewStacktraceLines({ prefix, windowHours, scanJobs })` | the stacktrace lines `LIKE prefix || '%'` of the newest `scanJobs` jobs updated in the window, newest job first and each job in order |
| `countDeadDreamSubmissionRows(spec)` | dead dream submissions per base key through the synthesize, patterns and per-transcript branches, with the persisted resets and the window applied |
| `listFactsAbsorbJobsByKeyPrefix({ prefix, keys })` | `facts-absorb` jobs whose key is `LIKE prefix || '%'` and that are dead, or whose key is in `keys`; by id |
| `listDeadFactsAbsorbJobsByKeys(keys)` | dead `facts-absorb` jobs whose key is in `keys`; by id |

Differences from PGLite:

- Orderings PGLite leaves open are fixed on both engines so a parity case can compare them: the embed sources
  (byte order), the spend rows, the dream phases, the dream count's tie-break (`base_key`) and the facts-absorb
  rows (by id). The SQL engines gained the `ORDER BY`; no caller depended on the old order.
- A prefix (the legacy spend prefixes, the build-skew prefix, the facts-absorb key prefix) is a `LIKE`
  pattern followed by `%` on every engine, as the doctor statements read it before they moved here: `_`
  matches any one character and `%` any run, and a backslash makes the next character literal. The store
  matches with the same rules (`jobs/status.rs` `like_tokens`). Matching the prefix literally is the
  follow-up doctor-prefix-literal in `TODOS.md`.
- `readGlobalMaintenanceDeaths` runs two statements on the SQL engines, outside a transaction. The store reads
  both from one snapshot.
- `since` is parsed when the call starts; text that is not `Date#toISOString` shaped is `INVALID_ARGUMENT`.
  Its one caller, `assessGlobalMaintenanceStall` (`src/core/minions/global-maintenance-stall.ts`), passes
  `new Date(...).toISOString()` or `null`, so no caller reaches the refusal today.
  A reset time in the dream count is parsed only for a key that has a counted row: garbage for such a key is
  `INVALID_ARGUMENT`, garbage for an absent key is ignored. The TypeScript member normalizes every reset
  through `toISOString` first.
- Timestamp text (`last_dead_at`, `finished_at` as text) uses UTC (`+00`), the session time zone PGLite runs
  in. A PostgreSQL brain in another time zone prints another offset for the same instant.
- A dead child with a NULL `error_text` does not count as a timeout death, as PostgreSQL's `bool_and`
  (a NULL operand is skipped, so the group stays true only if some row is a true timeout). A NULL
  `finished_at` is never inside a window. These two and the NULL-authority rows cannot be built through
  `admitJob` (the queue protocol trigger refuses a NULL authority), so the store tests cover them and the
  parity file does not.
- `listUnreviewedJobs` stays the member for the unreviewed-jobs gate. It carries no status and cannot tell
  SQL NULL from JSON null, so the legacy-authority check reads `readLegacyJobAuthority` instead.
- Not moved: `src/core/minions/idempotency-coalesce.ts` (it runs inside a transaction), the contained-failure
  and reset writes in `dream-breaker.ts`, `embed-backfill-stalled.ts` reading `page_projection_jobs`, and the
  `ingest_log` reads in `knowledge-health.ts`. They stay on `executeRaw`.

Accepted gaps (documented, not fixed in this family):

- `opts.signal` of `readWedgeSignals` and `readOldestWaitingAge` is ignored on the Rust engine (see
  `jobs-health.md`); a store call cannot be cancelled.
- `since` must be `Date#toISOString` text on the Rust engine (above); the SQL engines accept any text
  PostgreSQL casts to `timestamptz`.
- A child job whose parent carries a remote (OAuth client) authority is refused at `admitJob` on the Rust
  engine and admitted on PGLite: the store has no OAuth tables yet, so it cannot check the parent's grant.
  The parity file builds its children under the application authority. This closes with the OAuth family.
