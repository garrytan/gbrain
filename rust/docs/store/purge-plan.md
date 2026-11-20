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

## Not modeled

Withdrawal discovery is the typed member `readWithdrawalDiscovery` (rust/docs/store/facts.md), so a purge plan completes
on Rust, and its dry run reports every store the same as PGLite. The purge commit and its post-commit work still run
through `executeRaw`. Pinned by `test/engine-parity/purge-plan.test.ts` and
`test/engine-parity/purge-dry-run.test.ts`; the Postgres text is pinned by `test/purge-plan-sql-pin.test.ts`.
