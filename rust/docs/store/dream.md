# The brain store: Dream verdicts

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A dream verdict caches the triage judgment for one file version, keyed by `(file_path, content_hash)`
under key tag `Y`. A verdict lives 30 days from the write that stored it (`DREAM_VERDICT_TTL_SECONDS`).
It ports `src/core/engine-sql/dream.ts`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.getDreamVerdict(filePath, contentHash)` | `{ worth_processing, reasons, judged_at, score, content_type, segments, entities, model, triage_version }` or `null`. `null` also when the verdict expired (`expires_at <= now`). Missing lists read back as `[]`; `judged_at` is microsecond ISO text | `getDreamVerdict` |
| `brain.putDreamVerdict(filePath, contentHash, verdict)` | `null`; an upsert that replaces every field and sets `judged_at = now`, `expires_at = now + 30 days`. A missing `worth_processing` is `constraint_violation`; a non-integral or out-of-int4 `triage_version` and U+0000 in any text or JSON value are `invalid_argument`, and nothing is written | `putDreamVerdict` |
| `brain.sweepDreamVerdicts()` | the number of rows deleted, those with `expires_at <= now` | `sweepDreamVerdicts` |

JSON values (`reasons`, `segments`, `entities`) read back in jsonb key order: object keys sort by byte
length, then by bytes, at every depth. The TypeScript member applies `wellFormedJson` before the call,
so a lone surrogate becomes U+FFFD as it does on Postgres.

## Dream cycle statements (`src/core/engine-sql/dream-cycle.ts`)

The dream cycle, the retriage command and the consolidate phase used to send 37 raw statements through
`executeRaw`. They are now 34 typed `BrainEngine` members (three config-map statements were shared by the
breaker and the write deferral, so 37 sites make 34 members). The Rust engine refuses each member listed below
by name through `src/core/rust-engine/members.ts`; the capability it names is the data the store would
need before it can answer.

| Members | Needs from the store |
| --- | --- |
| `listDreamQueueCandidates`, `listLiveDreamCycleLocks`, `readDreamJobStatus`, `listDreamJobCreatedAt`, `listCompletedSynthJobs`, `countCoalescibleSynthJobs`, `listWaitingChildJobIds`, `listDreamChildJobTimings`, `countRecentDreamSynthSubmissions` | the minion job queue and the cycle lock table (`minion_jobs`, `gbrain_cycle_locks`), including the database clock and the jsonb `data` of a job |
| `stampDreamPageProvenance`, `listDreamPageIds`, `countDreamProvenancePages`, `listRetainedDreamOutputSources`, `listDreamAtomPages`, `listSynthesisPageBodies`, `readDreamVerifyEpoch` | pages: frontmatter merge that keeps the first cycle date, live page ids, counts by cycle date, atom and synthesis page reads (segmented pages are excluded in SQL), and the database clock |
| `listConsolidationClaimValues`, `setConsolidatedFactValidUntil`, `listReadersSourcedFactIds`, `listConsolidationClaimShapes` | facts: typed claim columns, `valid_until` writes and the readers-sourced predicate |
| `findConsolidationPageIds`, `readConsolidationTakesMaxRowNum`, `findConsolidatedTakes`, `refreshConsolidatedTakeSource`, `findConsolidatedTakeIds` | takes: row numbers, the earliest take of a claim and the source-aggregation write |
| `readDreamPreRunRevision` | the first page version snapshot at or after a time |

Served by the Rust engine: `ensureDreamMapConfigRow`, `lockDreamMapConfigRow`, `writeDreamMapConfigRow` and `recordDreamBreakerReset`
(`gbrain-store` `dream_config`, see [config.md](config.md)) and `readDreamSourceIncarnation` (the source record's
incarnation).

The three journal reads are served from the request records (`gbrain-store` `persistence/dream_reads.rs`, TypeScript
members in `src/core/rust-engine/store-members/dream-journal.ts`):

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readWriteRequestById(id)` | the stored request; the member keeps `{ state, error_code, error_message }`, or null. An id that is not a UUID is `invalid_argument`, as the `::uuid` cast refuses it | `readDreamDeferralReceipt` |
| `brain.listLaterPersistenceRequests(sourceId, incarnation, slug, sequence)` | the requests of the source, incarnation and slug with `sequence` greater than the given bigint (text) and state queued, running, recovering or committed, by sequence. A sequence that is not an integer is `invalid_argument` | `listLaterPersistenceRequests` |
| `brain.listCommittedOutputRequests(requestIds, sourceId, incarnation)` | `[{ request }]`: the committed `put_page` requests of the source and incarnation whose request id is one of `requestIds`, newest sequence first; times as text, as `row_to_json` gives them. A request id that is not a UUID is `invalid_argument` | `listCommittedOutputRequests` | The lock takes no row lock: the store admits one write transaction at a time.
incarnation). The lock takes no row lock: the store admits one write transaction at a time.
`readDreamDeferralReceipt`, `listLaterPersistenceRequests` and `listCommittedOutputRequests` read the persistence
journal (`gbrain-store` `persistence::dream_reads`, see [persistence.md](persistence.md)).

Return shapes are the raw row shapes the callers read; timestamps come back as the driver returns them
(a `Date` or text), and the callers normalise them. The SQL text and bound parameters are byte-identical to
the statements they replaced (`test/dream-cycle-sites-sql-pin.test.ts`); behaviour on PGLite and Postgres is
pinned by `test/engine-parity/dream-cycle-sites.test.ts`.
