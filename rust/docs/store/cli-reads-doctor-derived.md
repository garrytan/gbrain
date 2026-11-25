# The brain store: doctor-derived reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements that doctor checks, the repair scans and the purge ran through `executeRaw` (second set, after
[cli-reads-doctor.md](cli-reads-doctor.md)). PGLite and Postgres run the same SQL as before
(`src/core/engine-sql/doctor-derived.ts`; the text is pinned by `test/doctor-derived-sql.test.ts`). The store answers from the records
each statement read (`crates/gbrain-store/src/cli_reads/doctor_derived.rs`, `doctor_derived_health.rs` and `doctor_derived_ledgers.rs`) and has no keys of its own. The TypeScript side is
`src/core/rust-engine/store-members/doctor-derived.ts`.

A doctor-derived member answers one of two ways on the Rust engine:

1. Served from the store's records (the table below).
2. Empty, with no store call, because the store keeps no writer for a relation the statement reads. No Rust brain ever holds a
   row there, so the empty answer is the one PGLite gives a brain that never wrote one. The relations: `belief_events`,
   `page_extraction_state`, `derived_generations`, `derived_generation_items`,
   `derived_generation_activations`, `extract_rollup_7d`. Members: `listRecordedTombstones`,
   `listAmbiguousExtractionInputs`, `countLedgerCoveredAtomRetirements`, `listLiveGenerationRetirements`,
   `listHeldGenerations`, `listPendingGenerationMembers`, `listOrphanGenerationCandidates`, `readExtractRollup7d`,
   `readExtractKindRollup7d` (the one all-null aggregate row), `listRecordedHaltReasons7d`. If a Rust writer for one of these relations lands, its member must move to the first kind in the
   same change.

No member is refused any more: the nine that were (wave 1) are served now, and the table lists them.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listBudgetLimitedRows(sourceId, signature)` | `{ source_id, state, reason, pages, chunks, chars }` per source, state and reason (`awaiting_approval` for none) of the holds not `open` on live pages without `embed_skip` that are over the inline limit (a segmented page's `body_bytes`, else the inline text's bytes) or held for an archive or call import, counting the live body's chunks with no vector (an inline page's chunk never embedded, or every chunk when the page carries another signature); groups with no waiting chunk are left out; by byte order of source, state and reason. The TypeScript side checks the column name as the SQL engines do | `listBudgetLimitedRows` |
| `brain.readBudgetHoldAge()` | `{ stale, oldest }` over the same holds (chunks or not): how many were updated more than a day ago, and the oldest update time as ISO text or null | `readBudgetHoldAge` |
| `brain.countSafeIndexPending(sourceIds?)` | `{ rebuildable, kept }` of live pages in unarchived sources chunked below the safe-chunk fence | `countSafeIndexPending` |
| `brain.countPagesByTypeAndOwner(sourceIds?)` | `{ src, type, own, n }` per source, type and writer ownership, `n` as text | `countPagesByTypeAndOwner` |
| `brain.listImageAssetFiles()` | the first 1000 `image/*` file rows by file id, with source root and page source path | `listImageAssetFiles` |
| `brain.listRestorableAtomRetirements(sourceIds)` | per source: restorable re-extraction retirements, origins, oldest and newest `retired_at`, hold end | `listRestorableAtomRetirements` |
| `brain.listTimelineHistoryBatch(sourceIds, afterId)` | the next 200 live inline pages after `afterId` that hold an own timeline row | `listTimelineHistoryBatch` |
| `brain.readPageCompiledTruths(ids)` | `{ id, body }` of the named pages (deleted ones too), by id | `readPageCompiledTruths` |
| `brain.listAtomFenceCandidates({ sourceIds, atomId, after, limit })` | live world atoms whose live origin page is unread or names a facts or takes fence | `listAtomFenceCandidates` |
| `brain.readEmbeddingBacklogAge(column)` | `{ age_s, unaged, backfilled }` over chunks of live pages (not `embed_skip`) with no vector | `readEmbeddingBacklogAge` |
| `brain.readAtomProvenanceCounts()` | `{ total, slug_unbound, drifted, source_changed, source_gone, oldest_ext }` over live atoms with a `source_hash` | `readAtomProvenanceCounts` |
| `brain.listBodyRecheckGroups()` | `{ page_id, sh, n }[]`: per (page, 16-character hash), the live atoms with a `source_hash` (a `pending:` marker only on a managed atom, which sheds it) and a `source_slug` naming a live inline page of their source whose hash is no live page's `content_hash` prefix there; by page id then hash in byte order, at most 200 | `listBodyRecheckGroups` |
| `brain.readBodyRecheckPage(pageId)` | `{ body_storage, compiled_truth, timeline }` of the page with this id (soft-deleted too), or null; `body_storage` is `segmented` for a segmented shell, else `inline` | `readBodyRecheckPage` |
| `brain.listBodyRecheckVersions(pageId)` | the newest 20 inline versions of the page that hold a body, newest first: `{ compiled_truth, timeline, title, type, frontmatter, tags }` | `listBodyRecheckVersions` |
| `brain.countCredentialProjectionPending(sourceIds?)` | `{ rebuildable, kept }` of live pages with a private key block and a projection behind the knowledge revision | `countCredentialProjectionPending` |
| `brain.readIgnoredPrivacyLabelCounts(sourceIds?)` | up to 50 `{ key, raw, is_string, pages, scanned, groups }` groups of access labels the privacy filter ignores | `readIgnoredPrivacyLabelCounts` |
| `brain.countDerivedVisibility(sourceIds)` | the six derived-visibility counts of the named sources | `countDerivedVisibility` |
| `brain.listUntiledSegmentedPageRows(sourceIds?, slugs?, limit)` | live segmented pages whose published rows do not tile the body, by source and slug | `listUntiledSegmentedPageRows` |
| `brain.listOntologyFactCandidates(sourceIds)` | facts an ontology stint wrote, in id order, with `withdrawn`, `consolidated` and `duplicate` verdicts | `listOntologyFactCandidates` |
| `brain.listAmbiguousExtractionInputs()` | `{ page, grammars, total }` per live conversation page held for an undetected format, newest first, at most 20 | `listAmbiguousExtractionInputs` |
| `brain.listExtractionInputReceipts()` | `{ pipeline, kind, pages, samples }` per extraction-state or derivation receipt that says an extraction read only part of its input | `listExtractionInputReceipts` |
| `brain.listUnpricedDerivationModels()` | `{ model, pipelines, pages, samples }` per model a derivation receipt says had no price | `listUnpricedDerivationModels` |

## How each read follows the SQL

- `countSafeIndexPending`: a page counts when it is live, its source exists and is not archived (`s.archived IS NOT TRUE`), and its
  chunker version is below `SAFE_FENCE_CHUNKER_VERSION`. A record with no version counts as below it, as `safeChunksFilter` does.
  `rebuildable` is `page_kind = 'markdown'` or a code page with a `file` frontmatter key or a source path.
- `countPagesByTypeAndOwner`: live pages grouped by source, stored type and `WRITER_OWNED_PAGE_SQL`. The SQL orders by source
  only; the store orders by source, type, owner, so a caller must not depend on the order inside a source.
- `listImageAssetFiles`: `files` rows by file id whose mime type starts `image/`; the source root is `sources.local_path` of the
  file's source (null when the source row is gone) and the page source path is the file's page's `source_path`, soft-deleted pages
  included. `metadata` comes back as the JSON the store keeps (key order is Postgres jsonb order).
- `listRestorableAtomRetirements`: the store's `restorable_atoms` rule (the same one the purge hold uses) over the pages of the
  named sources. The store keeps no generation ledger, so no retirement is ledger-covered and every restorable one is listed.
  `oldest` and `newest` are the min and max of the `retired_at` text by bytes. `hold_until` is the oldest `deleted_at` of the
  group plus 30 days, whole seconds, UTC.
- `listTimelineHistoryBatch`: an inline page is one with stored text (a segmented page has NULL `compiled_truth` and `timeline`).
  An own row is a timeline entry with no event page.
- `listAtomFenceCandidates`: the origin page is the live page of the atom's source whose slug is the atom's `source_slug`. `text`
  joins the atom's title, compiled truth and `source_quote` with newlines, skipping the NULL ones (`concat_ws`). The statement
  deadline (`timeoutMs`) has no effect: the store answers from one snapshot.
- `readPageCompiledTruths`: `body` is null for a segmented page.
- `readEmbeddingBacklogAge`: the store keeps one vector per chunk, so `column` names the only column there is. `age_s` is now minus the
  oldest `pending_since` of a chunk with no vector; `unaged` counts those with none. `backfilled` compares that oldest stamp with the config
  key `embedding_pending_since_backfilled_at`, which the Rust store never writes, so it is `null` (as on a PGLite brain that never ran the
  backfill). Wave 1 said the store keeps no per-chunk pending-since stamp; it does (`embed.pending_since_us`).
- `readAtomProvenanceCounts`: a live atom with a `source_hash` is bound when it names a `source_slug`; it has drifted when no live page of its
  source has the first 16 characters of the hash as `content_hash`, and is `source_changed` when its source page (or the page a `rename`
  alias moved it to) is live, `source_gone` when not. A `pending:` hash counts only on a managed atom, which sheds the prefix.
- `countCredentialProjectionPending`: the key marker is `-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----` in the compiled truth or timeline (the store
  has no regex crate, so `has_private_key_marker` matches it by hand), or a published `pem` protected region for a segmented page.
- `readIgnoredPrivacyLabelCounts`: the Unicode edge trim is the one `facts/privacy.rs` already uses. At most 100001 pages are scanned.
  The statement deadline has no effect: the store answers from one snapshot.
- `countDerivedVisibility`: the store keeps no folder access rules and no pending access coverage, so those two terms are false, as in
  `facts/privacy.rs`. The `looser_*` counts follow the atom origin, the concept-provenance links and the life-chronicle `event.depth` slug.
- `listUntiledSegmentedPageRows`: covered and gapless come from the published manifest rows of the page's live generation. The generation
  flip refuses a body its rows do not tile, so a store written through the typed members never lists a page; the read is the guard against a
  torn write.
- `listOntologyFactCandidates`: `duplicate` is another fact with a different id sharing source, entity, dimension, value hash and valid-from
  whose source page is this fact's `source`. `withdrawn` is the withdrawal ledger's own claim match. `expired_at` is ISO text.
- `listAmbiguousExtractionInputs`: the `conversation_facts` receipts of kind `detection_ambiguous` in `page_extraction_state`
  ([page_extraction_state.md](page_extraction_state.md)) on live pages, newest `updated_at` first then page id, at most 20, each with
  the receipt's `grammars` and `total`, the count of every held page.
- `listExtractionInputReceipts`: the receipts of `page_extraction_state` (any kind but `detection_ambiguous` and `grammar_chosen`; a
  receipt without a kind reads `unknown`) and of `page_segment_derivations` (any kind but `unpriced_model`, or the
  `purge_sweep_pending` reason) on live pages. A page held for an undetected format hides its derivation receipts for that pipeline.
  A page with both kinds of receipt under one pipeline and kind counts once and lists twice, as the SQL's `UNION ALL` does.
  Groups come by pipeline then kind.
- `listUnpricedDerivationModels`: the receipts of `page_segment_derivations` on live pages, unpriced models by page count then model.

`crates/gbrain-store/tests/cli_reads_doctor_derived.rs` and `cli_reads_doctor_derived_health.rs` cover each read; `test/engine-parity/doctor-derived.test.ts` compares the
engines.
