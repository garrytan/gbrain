# The brain store: belief ledger events, commit marks and redactions

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The belief ledger appends one `belief_events` row per change (`src/core/belief/append.ts`), marks each publication once it
commits (`belief_commit_marks`), and keeps a register of redactions (`belief_redactions`). `enableBeliefLedger`
(`src/core/belief/coverage.ts`) reads the newest coverage event and walks the source's slugs, baselining each. PGLite and
Postgres run those statements, now in `src/core/engine-sql/collate-belief-writes.ts`. The store answers from its own records
(`crates/gbrain-store/src/belief_events.rs`). The TypeScript members are in
`src/core/rust-engine/store-members/collate-belief-writes.ts`.

Nothing in a shipped Rust brain calls these yet. `readLedgerSource` (in `store-members/persistence.ts`) reports no coverage,
so no batch opens and the families stay empty until it does. The members are classified `belief_ledger`, a capability the
engine keeps unreported while the ledger's state read (`readBeliefHistoryRows`) still refuses. The purge epoch read is the
existing `readSourcePurgeEpoch` member (it answers 0 for a known source and null for an unknown one).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readBeliefCoverage(sourceId, coverageKey)` | `{ event_type, run, recorded_at, id }` or null | `latestCoverage` |
| `brain.hasBaselineEvent(sourceId, slug, runId)` | boolean | `lacksBaseline` |
| `brain.countBaselinedSlugs(sourceId, runId)` | number | the completion count in `enableBeliefLedger` |
| `brain.listPendingBaselineSlugs(sourceId, runId, after, skip, limit)` | slugs | `pendingSlugs` |
| `brain.listPurgedFingerprints(sourceId, factFps, takeFps)` | fingerprints | `tombstoned` |
| `brain.readBeliefRedactions(sourceId, subjectKeys, fieldHashes)` | `[{ id, subject_key, field, purge_request, field_hash, released_hash }]` | `applyRedactions` |
| `brain.insertBeliefRedaction(sourceId, subjectKey, field, purgeRequest, fieldHash)` | the new id | `applyRedactions` |
| `brain.releaseBeliefRedactions(ids, publicationId, releasedHash)` | nothing | `applyRedactions` |
| `brain.insertBeliefEvents(rows)` | how many rows it inserted | `appendBeliefEvents` |
| `brain.recordBeliefCommitMarks(publicationIds)` | nothing | `markBeliefCommits` |

## Keys

Under the facts family (`F`), with sub-tags the facts records do not use. A text part ends with a NUL byte, and no text
column may hold one (the store refuses it, as it does everywhere).

| Key | Value |
| --- | --- |
| `F 0x21 <source> 0x00 <id, 8 bytes big endian>` | the event: its id, `recorded_at` and the row as JSON. A scan of one source meets events in id order |
| `F 0x22 <event key, lower hex>` | the event's id: the table's `UNIQUE (event_key)` |
| `F 0x23 <publication uuid> 0x00 <id, 8 bytes big endian>` | the event's source id: the events of one publication |
| `F 0x24 <id, 8 bytes big endian>` | the redaction: its register row, release included |
| `F 0x25 <publication uuid>` | the commit mark's `observed_at`, microseconds, 8 bytes big endian |

Ids come from the counters `next_belief_event_id` and `next_belief_redaction_id`, which start at 1 as the `BIGSERIAL`
columns do. The tables have no foreign key to `sources`, so nothing cascades: a removed source keeps its events, marks and
redactions, and `readBeliefCoverage` (which joins the source's incarnation) answers nothing for it.

## What each member answers

| Member | Rule |
| --- | --- |
| `insertBeliefEvents` | Inserts in `ord` order, each with the next id and the call's clock as `recorded_at`. A row whose event key exists, also one earlier in the same call, is skipped and not counted. A row that breaks a column check (`subject_kind`, `origin`, `tier_basis`), holds text that is not JSON in `value` or `cause`, names a bad uuid or hex key, or holds a NUL refuses the whole call and saves nothing |
| `readBeliefCoverage` | The newest event (highest id) of the source's current incarnation whose subject is the coverage key and whose type is not `coverage.restored`. `run` is `cause->>'run'`. An unknown source answers null |
| `hasBaselineEvent`, `countBaselinedSlugs` | A baseline event is one of type `baseline` whose `cause->>'run'` is the run. The count is of distinct slugs, over every incarnation, as the SQL is |
| `listPendingBaselineSlugs` | Slugs of the source's pages (soft-deleted too), of the entity of each active fact filed on no page, and of the page of each active dimension fact with no row number, that are bytewise after `after`, not in `skip` and not baselined by the run, in byte order, at most `max(1, limit)` |
| `listPurgedFingerprints` | The fingerprints among `factFps` that a fact purge tombstone of the source names, at any visibility and subject. A Rust brain keeps no take purges, so `takeFps` match nothing |
| `readBeliefRedactions` | The source's register rows under any subject key or any field hash, in id order. `purge_request` is lower case |
| `insertBeliefRedaction`, `releaseBeliefRedactions` | The register stores one row per call (no uniqueness). A release names the registered rows among the ids and skips an unknown id |
| `recordBeliefCommitMarks` | Marks each publication that has events and no mark yet, all at one instant, provided no event of it was recorded after that instant. A bad uuid refuses the call |

The commit mark has no typed read (nothing on the engine reads one). The store's `read_belief_commit_mark` exists for its
tests.

## Differences from the SQL engines

- The SQL columns `source_time`, `valid_from` and `valid_until` cast their text with `::timestamptz`, so Postgres refuses
  text that is not a timestamp. The store keeps the text as given and does not validate it. `appendBeliefEvents` only sends
  ISO text it formatted.
- `recorded_at` is the call's single clock reading. Postgres reads `clock_timestamp()` per row, so two rows of one call
  differ there by a few microseconds. Nothing orders by it (ids order events).
