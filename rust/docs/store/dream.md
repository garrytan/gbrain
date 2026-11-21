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
breaker and the write deferral, so 37 sites make 34 members). The Rust engine serves all 34. The TypeScript
members are in `src/core/rust-engine/store-members/dream-config.ts` and `dream-cycle.ts`.

| Members | Store code and rules |
| --- | --- |
| `listDreamQueueCandidates`, `listLiveDreamCycleLocks`, `readDreamJobStatus`, `listDreamJobCreatedAt`, `listCompletedSynthJobs`, `countCoalescibleSynthJobs`, `listWaitingChildJobIds`, `listDreamChildJobTimings`, `countRecentDreamSynthSubmissions` | `gbrain-store` `jobs/dream_reads.rs`, over the job records and the cycle locks. A job's source is `data.source_id`, `default` when it is missing or empty. `listDreamJobCreatedAt` refuses an id outside int4, as the `int[]` cast does. A non-finite steal grace refuses |
| `stampDreamPageProvenance`, `listDreamPageIds`, `findConsolidationPageIds`, `countDreamProvenancePages`, `listRetainedDreamOutputSources`, `listDreamAtomPages`, `listSynthesisPageBodies`, `readDreamVerifyEpoch` | `gbrain-store` `dream_reads.rs`, over the page records. The stamp merges the frontmatter, keeps the first cycle date in both date keys, and gives the page a new knowledge revision only when the frontmatter changed. `listDreamPageIds` and `findConsolidationPageIds` are one store call. An atom page's `private` is the no-caller page policy. Slugs and raw sources sort in byte order. A segmented page (a NULL body) is not a synthesis body |
| `readDreamDeferralReceipt`, `listLaterPersistenceRequests`, `listCommittedOutputRequests` | `dream_reads.rs`, over the write journal. A request id or incarnation that is not a uuid refuses as the `uuid` cast does; a sequence that is not an integer refuses as the `bigint` cast does |
| `listConsolidationClaimValues`, `setConsolidatedFactValidUntil`, `listReadersSourcedFactIds`, `listConsolidationClaimShapes` | `dream_reads.rs`, over the fact records. The `valid_until` write is a no-op when the fact already holds the value. A readers-sourced fact is one whose source page (live or deleted, same source) names readers |
| `readConsolidationTakesMaxRowNum`, `findConsolidatedTakes`, `refreshConsolidatedTakeSource`, `findConsolidatedTakeIds` | `dream_reads.rs`, over the take records. A row number outside int4 refuses |
| `readDreamPreRunRevision` | `dream_reads.rs`: the first version snapshot at or after the time, by snapshot time then id, of the page live or deleted |
| `ensureDreamMapConfigRow`, `lockDreamMapConfigRow`, `writeDreamMapConfigRow`, `recordDreamBreakerReset`, `readDreamSourceIncarnation` | `gbrain-store` `dream_config` (see [config.md](config.md)) and the source record's incarnation. The lock takes no row lock: the store admits one write transaction at a time |

Return shapes are the raw row shapes the callers read. On the Rust engine the TypeScript members give
timestamps back as Dates, as PGLite does; the `request` of `listCommittedOutputRequests` keeps them as text,
as `row_to_json` does. The SQL text and bound parameters are byte-identical to
the statements they replaced (`test/dream-cycle-sites-sql-pin.test.ts`); behaviour on PGLite and Postgres is
pinned by `test/engine-parity/dream-cycle-sites.test.ts`.
