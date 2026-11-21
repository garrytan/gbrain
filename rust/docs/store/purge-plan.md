# The brain store: fact purge plan, dry run and `--match` reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`gbrain forget <id> --purge` plans what it rewrites (`planFactPurge`, `src/core/facts/purge.ts`), reports what would
still carry the claim in a dry run (`verifyFactPurge`, `src/core/facts/purge-verify.ts`), finds the requests that
carry it (`findRequestsCarrying` and `findRequestsHoldingStagings`, `src/core/persistence/intent-redaction.ts`) and walks
derivations (`derivedRowsFrom`, `src/core/facts/derivation-inputs.ts`); `--match` lists candidate facts. PGLite and
Postgres run the SQL in `src/core/engine-sql/facts-purge.ts` and `src/core/engine-sql/facts-purge-plan.ts` (statement
texts of the latter in `src/core/facts/purge-plan-statements.ts`); the Mirrors column names the engine member. The store answers from the page, version, body, fact, request, link,
timeline and raw-data records the other families write (`crates/gbrain-store/src/facts/purge_plan.rs`, with the body
scans in `page_body/purge_scan.rs`). It keeps no records of its own and adds no key prefix.

A claim matches as the SQL does: `strpos(lower(text), needle) > 0`, with `lower` the Postgres lowering
(`pg_lower`). Segment and staging text is decoded as UTF-8; bytes that are not UTF-8 refuse with
`invalid byte sequence for encoding "UTF8"`, as `convert_from` does.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.hasLivePageSlug({ sourceId, slug })` | whether the source has a live page at the slug | `purgeSubjectPageLive` |
| `brain.readPurgeTakePages({ sourceId, pageIds })` | `[{ slug, page_id, revision }]` of the source's pages among the ids | `listPurgePagesById` |
| `brain.countPurgeCarryingVersions({ sourceId, claimLower, claimJson, reason })` | the source's page versions whose body, timeline, title, frontmatter JSON, change reason or segmented generation carries the claim | `countPurgeVersionsCarryingClaim` |
| `brain.listStagingsHoldingClaim({ sourceId, claimLower, claim, cellLower })` | the ids, sorted, of the source's live stagings whose manifest or staged texts hold the claim | `listStagingsHoldingClaim` |
| `brain.countPurgeReviewRows({ sourceId, factIds })` | `{ q, rp, dp }`, the review queue, review proposal and decide proposal rows naming the facts | `countPurgeReviewRows` |
| `brain.matchPurgeCandidates({ sourceId, text })` | up to 25 facts of the source containing the text, by id, each cut to 160 characters | `listPurgeMatchCandidates` |
| `brain.listRequestsCarryingClaim({ sourceId, claimLower, claimJson, reason, limit })` | `[{ id, principal_kind, principal_id }]` by sequence, up to `limit`, whose intent, outcome or error text carries the claim | `listRequestsCarryingClaim` |
| `brain.listRequestsHoldingStagings({ sourceId, stagingIds })` | the unfinished (`queued`, `deferred`, `running`, `recovering`) requests whose `intent.body_ref.staging_id` is one of the ids, by sequence | `listRequestsHoldingStagings` |
| `brain.listSegmentedPurgeBodies({ sourceId, store, limit })` | the source's segmented live pages (`store: 'pages'`, by id) or page versions (`'page_versions'`, by version id) | `listSegmentedPageBodies`, `listSegmentedVersionBodies` |
| `brain.countLegacyDerivedPages({ sourceId })` | the source's live `atom` and `dream_generated` pages (the store keeps no derivation edge, so every one counts) | `countLegacyDerivedPages` |
| `brain.listPageSourcePaths({ pageIds })` | the distinct relative `source_path` values of the pages and their versions, at most 64 | `listPageSourcePathsForPurge` |
| `brain.listFactNeighbours({ embedding, sourceId, model, claim })` | the five same-model facts nearest the embedding (halfvec cosine), with `contains_claim` from the fact normalizer | `listNearestFactsForPurge` |
| `brain.countPurgeProbe({ table, sourceId, columns, needles, rows })` | the rows of a probed table carrying a needle, at most `rows + 1` | `countPurgeProbe` |
| `brain.listPurgeProbeItems({ table, sourceId, columns, needles })` | the first 20 item names, sorted, or null when the store keeps no name for the table's rows | `listPurgeProbeItems` |
| `brain.countPurgeStoreProbe({ probe, rows })` | a page purge receipt's store probe (`probe.kind`, below): the rows still naming the purged page, at most `rows + 1` | `countPurgeProbe` |
| `brain.listPurgeStoreProbeItems({ probe })` | the first 20 `effect:<id> <kind> <state>` items, sorted, of an `effect_payload` probe; any other kind refuses | `listPurgeProbeItems` |

## Members the JS layer answers

- `listStagingPartEdges` and `listDerivedRows` answer `[]`: the store keeps no staging parts and no derivation
  edges. `setPurgeProbeTimeout` does nothing: a store read has no statement deadline.
- The probes (`store-members/purge-plan.ts`): the store probes `links` (context of links from or to the source's
  pages, item `link:<id> <from> -> <to>`), `timeline_entries` (summary and detail, item `timeline:<id> <slug> <date>`),
  `raw_data` (the data's JSON text, item `raw_data:<id> <slug> <source>`; naming a row written before the store kept
  its id refuses) and `wanted_links`. Every other inventory
  table the store keeps is probed whole from its own records (`facts/purge_probe.rs` `table_rows`, one row reader per
  store): text columns match lowercased, JSON columns as Postgres prints them, text arrays as an array literal, and the
  bytea `minion_attachments.content` by its raw bytes. A table the store keeps no rows of answers 0 and `[]`.

## A page purge receipt's store probes

`facts/purge_store_probe.rs` answers the probes `verifyPagePurge` runs (`engine-sql/purge-verify.ts`
`purgeStoreProbeSelect` is the SQL it matches). A probe never answers 0 for a store the brain keeps: a store the Rust
engine keeps is read, and a store it keeps no rows of is answered 0 by the member without a store call.

| `probe.kind` | Store | Reads |
|---|---|---|
| `slug_key` `pages` | pages | the page at (source, slug); a soft-deleted page counts |
| `slug_key` `facts` | facts | the facts of the source filed on the slug (`source_markdown_slug`) |
| `slug_key` `take_proposals`, `open_loops` | proposal queue, loops | the rows of the source filed under the slug |
| `slug_key` `page_aliases`, `slug_aliases` | aliases | the page's alias rows; the alias rows naming the slug as canonical |
| `slug_key` `eval_candidates.retrieved_slugs` | eval candidates | candidates covering the source that retrieved the slug, with no page of that slug in another covered source |
| `slug_key` `files` | file records | files with no page that name the slug in the source (the store keeps every file's source, so the SQL's NULL-source arm matches none) |
| `slug_key` `write_gate_holds` | write-gate holds | the holds of the source on the slug, any status |
| `page_rows` | chunks, versions, takes, timeline | the page's rows by id |
| `fact_refs` | decide proposals, review queue, review proposals | the rows naming a fact id (`countPurgeReviewRows`' reader) |
| `trust_proposals` | trust proposals | proposals of the source naming the page or a fact as target or related row |
| `page_requests` | journal | other requests of the source, filed on the slug and finished, or whose intent, outcome, error detail or message holds a needle (or, on the slug, a reason) |
| `page_segment_texts` | segment texts | texts of the source that no manifest row names and no live staging recorded, with one of the shas or holding a lowered form |
| `segment_texts` | segment texts | texts of the source holding a needle byte for byte, named by a manifest row or not as asked |
| `effect_payload` | effects | effects of the source whose data, outcome or recovery holds a form, or (given a page) its Git effects on the slug whose data holds a reason form |

Answered 0 in the member, because the store keeps no such rows: `core_edit_notices`, `retrieval_event_pages`,
`retrieval_event_links`, `retrieval_feedback`, `retrieval_weights`, `context_volunteer_events`,
`mention_gazetteer_entries` and `query_cache` (as `clearQueryCache` answers 0). Refused naming the kind: the fact purge's
`fingerprint` and `claim_text` probes. A segment text that is not UTF-8 refuses, as `convert_from` does. Pinned by
`rust/crates/gbrain-store/tests/purge_store_probe.rs` and `test/engine-parity/page-purge-probes.test.ts`.

## Not modeled

Withdrawal discovery is the typed member `readWithdrawalDiscovery` (rust/docs/store/facts.md), so a purge plan completes
on Rust, and its dry run reports every store the same as PGLite. The purge commit and its post-commit work still run
through `executeRaw`. Pinned by `test/engine-parity/purge-plan.test.ts` and
`test/engine-parity/purge-dry-run.test.ts`; the Postgres text is pinned by `test/purge-plan-sql-pin.test.ts`.
