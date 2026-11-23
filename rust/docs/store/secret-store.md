# Secret store and `gbrain repair secret-spans`

The Rust store serves the secret store (GST-2988) and the page-store reads and writes of `gbrain repair secret-spans`, so
the repair previews and applies on a Rust brain, and `gbrain secrets` lists, restores, backs up and cascades there. The SQL
engines run the statements `secret-store/store.ts`, `restore.ts`, `spool.ts` and `repair/secret-spans.ts` ran through
`executeRaw`; they are typed members now (`src/core/engine-sql/secret-store.ts`, `secret-spans-rows.ts`; the queue row is main's `queuePageProjectionJob`, engine-sql/projection-rebuild.ts) and a Rust brain serves each from what the store keeps
(`src/core/rust-engine/store-members/secret-store.ts`). The crypto stays in TypeScript (`secret-store/keyring.ts`): the
store keeps the ciphertext, nonce, tag and MACs it is given and never sees a value. Each write member is one store write, so
the engine's transaction holds a repair's writes together.

Files: `gbrain-store/src/secret_store.rs`, `gbrain-store/src/repair_secret_spans.rs`,
`gbrain-store/src/timeline_queries/redaction.rs`, `gbrain-napi/src/families/secret_store.rs`. Cargo tests:
`tests/secret_store.rs`, `tests/repair_secret_spans.rs`. Parity: `test/engine-parity/repair-secret-spans.test.ts`.

## Keys (tag `3`, `keys::SECRET_STORE`)

`x` was the last free letter (`y` is reserved for `SESSION_STATE`). The byte after the tag names the record.

| Key | Value | Table |
| --- | --- | --- |
| `x 0x01 <entry id>` | the entry: source, rule, ciphertext, nonce, tag, key id, key host, value MAC, status, created and updated micros | `secret_store` |
| `x 0x02 <source> \0 <value_mac>` | the entry id | `UNIQUE (source_id, value_mac)` |
| `x 0x03 <entry id> \0 <occurrence id be8>` | empty | `secret_store_occurrence_entry_idx`, `ON DELETE CASCADE` of the entry |
| `x 0x04 <occurrence id be8>` | the occurrence: entry, source, page id, slug, field, origin, commit, path, line, pre-field hash, created by, created micros | `secret_store_occurrence` (ids from `M next_secret_occurrence_id`) |
| `x 0x05 <source> \0 <slug> \0 <occurrence id be8>` | empty | `secret_store_occurrence_page_idx` |
| `x 0x06 <page id be8> <occurrence id be8>` | empty | `page_id ... ON DELETE SET NULL` |

The CHECK constraints (`ss_` plus 12 hex id, rule `[a-z0-9_]{1,64}`, 16-hex key id, 64-hex MAC, status `active` or
`allowed`, the five origins, a 64-hex pre-field hash) and the foreign keys (a source for an entry, an entry and a page for an
occurrence) refuse as the tables do: `constraint_violation`, or `source_not_found` for an unknown source.

## Cascades

- A hard page delete (`deletePages`, `purgeDeletedPages`) clears the `page_id` of the page's occurrences (`cascade::remove_page_rows`),
  then removes the page's occurrences and every entry only they referenced (`secret_store::purge`, the cascade
  `purgeSecretsForSlugs` runs on the SQL engines). An occurrence recorded under a slug the page had before a rename goes by its
  page id, read before the delete; a place whose `page_id` names another live page stays, and so does a place recorded on a commit.
- A source delete removes the source's entries with their occurrences (`cascade::remove_source_rows`).
- A page rename (`updateSlug`) moves the occurrences recorded under the old slug when they are the renamed page's own, or have no
  page, and are not on a commit (`cascade::rename_slug_rows`; `moveSlugBindings` on the SQL engines).

## Members: the secret store

| Member | Mirrors SQL (`engine-sql/secret-store.ts`) |
| --- | --- |
| `findSecretEntryByMac(sourceId, mac)` | the entry id holding a (source, value MAC), or none |
| `secretEntryExists(id)` | `SELECT 1 FROM secret_store WHERE id` |
| `insertSecretEntry(row, conflict)` | `INSERT .. ON CONFLICT (source_id,value_mac) DO NOTHING` (`value`: an id clash still refuses) or `ON CONFLICT DO NOTHING` (`any`); status `active`, stamped now |
| `insertSecretOccurrence(o)` | `INSERT INTO secret_store_occurrence`, stamped now |
| `readSecretEntry(id)` | the entry row; `created_at` prints as `timestamptz::text` (`2026-11-21 10:00:00.123+00`) |
| `listSecretOccurrences(entryId)` | the entry's places in recording order |
| `listSecretEntrySummaries({ sourceId, slug, limit })` | entries oldest first then by id, with occurrence count and distinct slugs (no ciphertext, no MAC) |
| `countSecretsByRule(sourceId)` | entries and occurrences per rule, by rule in byte order |
| `listAllowedSecretMacs(sourceId)` | the key id and MAC of every restored entry; with no source, of every source in (key id, MAC) order |
| `listSecretKeysInUse()` | entries per (key id, host) |
| `readSecretStoreSnapshot()` | every entry and occurrence from one snapshot; a page place carries the slug its page has now; timestamps are UTC ISO milliseconds |
| `insertBackupSecretEntry(row)` | the backup insert: skipped for an unknown source or a held id or (source, value) |
| `readBackupEntryHold(id, sourceId, mac)` | whether the row under `id` holds this (source, value); none when no row has the id |
| `insertBackupSecretOccurrence(o, pageId)` | the backup occurrence insert: a page place needs `pageId` to name a page of the source at its slug; an identical row (to the millisecond) is not written twice |
| `deleteUnreferencedSecretEntry(id)` | deletes an entry no occurrence references |
| `listSecretHoldingPages(sourceId, slugs, id)` | the pages at these slugs (a tombstone included) with whether they are segmented and whether their inline stores hold the marker (`pageHoldsSql`) |
| `countUnreferencedSecretEntries()` | the doctor count |
| `readRestorePageHit(sourceId, slug, marker)` | the live page's revision and whether its title, body, timeline or frontmatter holds the marker (a segmented page counts as a hit) |
| `markSecretEntryAllowed(id)` | status `allowed`, updated now |

The purge is not a member on the Rust brain: the store runs it inside `deletePages` and `purgeDeletedPages`. On the SQL engines
`purgeSecretsForSlugs` runs the cascade through `engine-sql/secret-store.ts purgeSecretOccurrences`.

## Members: `gbrain repair secret-spans`

| Member | Rust brain |
| --- | --- |
| `readPageRedactionRow(sourceId, slug)` | the live page: columns, tags sorted, the body's storage state, generation, contextual retrieval state |
| `readPageRedactionRows(pageId, sourceId, slug)` | timeline rows (the page's and the event projections that name it), the facts it holds or that name it with no holder, takes, link contexts and raw data, each in id order |
| `listTimelineDedupRows(pageId)` | every entry of the pages those rows belong to (`timeline_queries/redaction.rs`) |
| `listVersionBodiesForRedaction(pageId)`, `countPageVersionRows(pageId)`, `setRetainedVersionBody(pageId, id, text, frontmatter)` | the page's retained versions |
| `listChunkTextsForRedaction(pageId, purpose)`, `deleteChunksByIds(pageId, ids)` | chunk rows with their doc comments; the delete goes through `delete_chunks_matching` (postings and the records under a chunk follow) |
| `setRedactedPageFields(pageId, fields)` | `write_page_setting_vector`: a changed field takes a new knowledge revision and clears the text projection seal, the keyword index and the projection queue follow |
| `readRawDataValue(pageId, id)`, `setRawDataValue(pageId, id, data)` | see below |
| `setRedactedRowText(pageId, store, id, column, text)` | timeline: `put_entry` (the dedup key moves, a taken key refuses); facts: `write_fact` (the embedding goes); takes: `rewrite_take_column` (the embedding goes, a claim change counts in `claim_rev`); links: `put_link` (the keys stay) |

Segment derivations are read and retired through the existing `readSegmentDerivations` and `retireSegmentDerivations`; the receipt
is `readOpCheckpointRecord` and `writeOpCheckpointRecord`; the page revision after a write is `readPageRevisions`; the view digests
`deletePageViewDigests` (the store keeps none, so it has nothing to delete).

## Differences from the SQL engines

- A raw data row has no serial id here (one record per page and source). `readPageRedactionRows` numbers a page's rows from 1 in
  source order, so a field key reads `raw_data/1/data/...`, and `readRawDataValue` and `setRawDataValue` take that number with the page id.
- The reseal of the page's chunks after the commit (`resealSafeChunks`, `buildSegmentedProjection`) runs raw SQL the store does not
  serve. On the Rust brain the apply (and `gbrain secrets restore`) leaves the page's projection queued: the rewrite deletes the
  chunk rows that held a value and queues the page, the detail says `projection: queued`, and the queue rebuilds the chunks.
  `--embed` after an apply embeds nothing there for the same reason.
- A segmented body write (`applySegmentedBody` stages and flips through raw SQL) stops by name, before the page is written:
  `repair secret-spans segmented body write`. A Rust brain holds no segmented page the TypeScript import path could make (page body
  staging refuses there too), so the stop is not reached today.
- The twin merge moves no secret occurrence on any engine: `movePageIdReferences` moves them only for a sync rename's fallback,
  which a Rust brain does not run.
