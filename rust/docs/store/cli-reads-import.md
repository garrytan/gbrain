# The brain store: CLI import reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the reads that the CLI import and extract paths ran through `executeRaw`
(the `executeRaw` map in the Rust engine branch's research notes; it is not on master).
PGLite and Postgres run the same SQL as before, now in `src/core/engine-sql/cli-reads-import.ts`.
The store answers from its source, page and timeline records (`crates/gbrain-store/src/cli_reads/import.rs`)
and has no keys of its own.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listSourceRecords()` | every source, archived ones too, `default` first then by `id`: `{ id, name, local_path, last_commit, last_sync_at, config, created_at, archived, newest_content_at }`, dates as ISO strings | `listSourceRecords` |
| `brain.readSourceIncarnation(sourceId)` | `{ config, incarnation }`, or `null` for an unknown id | `readSourceIncarnation` |
| `brain.hasCompanyBrainReceipt(sourceId)` | always `false` | `hasCompanyBrainReceipt` |
| `brain.readGuestSourceRow(sourceId)` | always `{ hidden: false, source_id: null, writers: null, trust_ceiling: null }` | `readGuestSourceRow` |
| `brain.listGuestSourceIds(sourceIds)` | the given ids, each once and in id order, of sources whose config says guest | `listGuestSourceIds` |
| `brain.hasGuestSource()` | whether any source's config says guest | `hasGuestSource` |
| `brain.readPageTrustRows({ ids?, keys?, includeDeleted? })` | one row per page found: by id (deleted pages too) and by `{ source_id, slug }` key (live pages unless `includeDeleted`); `{ id, source_id, slug, trust_tier, write_origin, flagged, guest, byId }` | `readPageTrustRows` |
| `brain.readRowTrustRows({ table, ids })` | one row per `timeline_entries`, `facts` or `takes` id found, in id order; `{ id, trust_tier, write_origin, flagged, contested }` (`contested` is always null for a timeline row). Any other table refuses `invalid_argument` | `readRowTrustRows` |
| `brain.readDatabaseClock()` | the store clock, `YYYY-MM-DDTHH:MM:SS.ffffffZ` in UTC | `readDatabaseClock` |
| `brain.listLinkPageMetadata(sourceId?)` | live pages (of `sourceId` when given) by source then slug: `{ slug, source_id, type, title, aliases, knowledge_revision }`, `aliases` from the frontmatter or `null` | `listLinkPageMetadata` |
| `brain.listStoredTimelineRows(sourceId, slug)` | the page's timeline rows that no event page projects, by id: `{ id, date, source, summary, detail }`; the page may be soft-deleted | `listStoredTimelineRows` |
| `brain.filterPagesAtRevision(refs)` | `{ slug, source_id }` for each `{ source_id, slug, revision }` whose page is live and still at that knowledge revision; a repeated ref gives a repeated row | `filterPagesAtRevision` |

## What the store does not keep

Each answer below is what Postgres gives for a brain that never wrote the missing data.

- **Ingestion receipts.** The store keeps no `source_ingestion_receipts`, so `hasCompanyBrainReceipt` is `false`.
  The company-brain profile then reads the source as one that has not finished an ingestion.
- **Guest sources.** The store has no `guest_sources` table and no row-level security. A guest source is a source
  whose config has `guest` set to `true` or to the text `"true"`, as the SQL `config->>'guest' = 'true'` reads it.
  `readGuestSourceRow` is never hidden and never finds a row. This is the Postgres answer for a source that is a
  guest by config with no `guest_sources` row, so the import guard in `guests/admission.ts` lets the write through,
  as it does on Postgres for that source. No `guest_sources` row can exist on Rust: `guests/sources.ts` adds one
  through `executeRaw`, which the engine refuses with `engine_capability_missing`, so the guest admission is loud
  on Rust and the read stays true. Page trust stamping matches too, because the trigger's guest rules key on a
  `guest_sources` row only.
- **Page trust.** A page reads the `trust_tier` and `write_origin` its last write stamped
  ([`write_trust.md`](write_trust.md), "Page stamping"); a page written by an undeclared writer reads
  `trust_tier: 'unknown'` and `write_origin: null`. `flagged` is `activationSuppressedSql`: the page's tier is at or
  below `agent_written` and one of its write-gate receipts (`trust/write_gate.rs`) has the verdict `flag` and a reason
  family in `standing_instruction`, `override`, `exfiltration` or `credential`. An owner rewrite that raises the tier
  clears it and keeps the receipt. `guest` is the source's config value above.
- **Row trust.** A timeline, fact or take row reads the `trust_tier` and `write_origin` its last write stamped
  ([links-graph-timeline.md](links-graph-timeline.md), [facts.md](facts.md), [takes.md](takes.md)); `flagged` is
  the same activation test as a page, on the row's own receipts. A fact or take is `contested` when a pending
  `supersede_fact` or `supersede_take` proposal names it (`trust::proposals::contested_ref`, the lowest id first):
  `tp<id>:challenger` when it is the proposal's related row, `tp<id>:challenged` otherwise. A timeline row is never
  contested. Each row's `write_origin` reads in jsonb key order (`pg_text::jsonb_value`), as the column
  returns it.
- **Knowledge revision.** Every stored page has a UUID `knowledge_revision`; it is never `null`. The extract stamp's
  "no revision" sentinel therefore never matches a store page, as it never matches a Postgres page written since the
  column became `NOT NULL`.
- **Timeline detail.** `detail` is always a string; an entry written without one reads `''`, as the Postgres column
  default gives.
- **Sync routing row.** `readSyncDispatchRow` has no store method of its own: the shim
  (`src/core/rust-engine/store-members/cli-reads-import.ts`) builds it from `readSourceState` and
  `hasCompanyBrainReceipt`, and reads `claimed` from `isSourceClaimed`: true when a writer binding names the source at
  its current incarnation (persistence.md, "Worktree bindings"). The row answers `modes: [false]` for every source,
  which is true to the store: it keeps one unmanaged brain, as `readManagedModeRows` answers. An unknown id
  reads one row with null source columns, as the SQL's `LEFT JOIN` gives. PGLite and Postgres run the statement in
  `src/core/engine-sql/sync-dispatch.ts`.
