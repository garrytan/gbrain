# The brain store: CLI import reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the reads that the CLI import and extract paths ran through `executeRaw`
([docs/research/rust-cli-executeraw-map.md](../../../docs/research/rust-cli-executeraw-map.md)).
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
| `brain.readDatabaseClock()` | the store clock, `YYYY-MM-DDTHH:MM:SS.ffffffZ` in UTC | `readDatabaseClock` |
| `brain.listLinkPageMetadata(sourceId?)` | live pages (of `sourceId` when given) by source then slug: `{ slug, source_id, type, title, aliases, knowledge_revision }`, `aliases` from the frontmatter or `null` | `listLinkPageMetadata` |
| `brain.listStoredTimelineRows(sourceId, slug)` | the page's timeline rows that no event page projects, by id: `{ id, date, source, summary, detail }`; the page may be soft-deleted | `listStoredTimelineRows` |
| `brain.filterPagesAtRevision(refs)` | `{ slug, source_id }` for each `{ source_id, slug, revision }` whose page is live and still at that knowledge revision; a repeated ref gives a repeated row | `filterPagesAtRevision` |

## What the store does not keep

Each answer below is what Postgres gives for a brain that never wrote the missing data.

- **Commit columns.** A source has no `last_commit` and no `newest_content_at`. Both read `null`.
- **Ingestion receipts.** The store keeps no `source_ingestion_receipts`, so `hasCompanyBrainReceipt` is `false`.
  The company-brain profile then reads the source as one that has not finished an ingestion.
- **Guest sources.** The store has no `guest_sources` table and no row-level security. A guest source is a source
  whose config has `guest` set to `true` or to the text `"true"`, as the SQL `config->>'guest' = 'true'` reads it.
  `readGuestSourceRow` is never hidden and never finds a row. This is the Postgres answer for a source that is a
  guest by config with no `guest_sources` row, so the import guard in `guests/admission.ts` lets the write through,
  as it does on Postgres for that source.
- **Page trust.** Pages have no trust tier, no write origin and no activation-suppression receipts. Every page reads
  `trust_tier: 'unknown'` (the column default), `write_origin: null` and `flagged: false`. `guest` is the source's
  config value above.
- **Knowledge revision.** Every stored page has a UUID `knowledge_revision`; it is never `null`. The extract stamp's
  "no revision" sentinel therefore never matches a store page, as it never matches a Postgres page written since the
  column became `NOT NULL`.
- **Timeline detail.** `detail` is always a string; an entry written without one reads `''`, as the Postgres column
  default gives.
