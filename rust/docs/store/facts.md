# Facts store (`facts.rs`)

The `facts` table of the PGLite engine: facts, their supersession chains, page fences and
typed claims. Each member gives the answer PGLite gives today, odd behavior included.

## Members

| Member | What it does |
|---|---|
| `insertFact` | Inserts one row with the column defaults (`kind` fact, `visibility` private, `notability` medium, `confidence` 1.0, `valid_from` now). With `supersedeId` it expires the named unexpired row now and closes its validity at the new row's `valid_from`; the status is `superseded` whether or not that row was there. |
| `insertFacts` | One write: the optional page delete, then each row in order. A row whose fence key (`source, source_markdown_slug, row_num`) is taken is skipped, but its id is still used up. Then each `superseded by #N` reference is linked, with PGLite's four warnings (references itself, absent from the fence, struck without being superseded, cycle). |
| `deleteFactsForPage` | Deletes a page's rows, except rows whose `source` starts with an excluded prefix and, with `preserveExpiredLegacy`, expired rows with no fence key. |
| `expireFact` | Expires an unexpired row; `supersededBy` must name an existing row (`facts_superseded_by_fkey`); `successorFrom` closes validity. |
| `listFactsByEntity`, `listFactsSince`, `listFactsBySession` | Filtered lists, newest first, with `limit` and `offset`. `grep` is a pre-built ILIKE pattern, folded with Postgres `lower()` one code point at a time. |
| `listFactsKeyset` | Oldest first by `(created_at, id)` after a microsecond ISO cursor. |
| `listSupersessions` | Superseded rows, newest supersession first. |
| `countUnconsolidatedFacts`, `getFactsHealth` | Counts of active rows (and the five entities with the most). |
| `findCandidateDuplicates` | The recency arm: active same-entity rows, newest first, capped by `k`. The keyword arm (`keyword`, `factText`): the same rows less audit checkpoints, kept when `to_tsvector('english', fact)` matches the OR of the claim's `plainto_tsquery` lexemes (`keyword::or_of_lexemes`; none matches nothing), ordered by `ts_rank_cd` descending, then `created_at` and `id` descending. The cosine arm (`embedding`, no `keyword`): the same rows less audit checkpoints, kept when comparable (a vector from `embeddingModel`, `embedded_text_hash = md5(fact)`, the query's width), ordered by `halfvec` cosine distance to the query (cast to `halfvec` too; NaN last; equal distances by id). The keyword arm with an `embedding` keeps only the comparable rows and does not read the vector. An `embedding` with no (or an empty) `embeddingModel` finds nothing. The member refuses the keyword arm when `GBRAIN_FTS_LANGUAGE` is not `english`. |
| `consolidateFact` | Stamps `consolidated_at` and `consolidated_into`. |
| `findTrajectory` | Typed claims and events of an entity, oldest first, world rows only for remote callers. A point carries its `embedding` only when its `embedding_model` is the `embedding_model` config value and its `embedded_text_hash` is `md5(fact)`; otherwise null. |
| `listUnattributedFacts` | The review-list read of `src/core/review-lists.ts`: active rows with no `entity_slug` in any of `sourceIds` (duplicates read once), less rows whose page or entity page is soft-deleted, `worldOnly` keeping `visibility = 'world'`, newest id first, then `offset` and `limit`. Each row is `id, fact, kind, visibility, source_id, created_at, source`, `created_at` in the `timestamptz::text` form (`2026-06-18 09:00:00.5+00`). `excludePrivate` applies the private-provenance policy below, as `src/core/review-lists.ts:30` does. The `BrainEngine` member `listUnattributedFacts` (`src/core/rust-engine/store-members/facts.ts`) calls it in place of the SQL of `src/core/engine-sql/cli-reads-ops.ts`; its `excludePrivateProvenance` becomes this policy. |
| `pageCollapseFacts` | The collapse-stage read of hybrid search (`facts/collapse.rs`, SQL in `src/core/engine-sql/search-reads.ts`): one `{ id, target, body_chars, body, lead }` row per page row whose id is in `ids`, soft-deleted pages and every source included, by id (the SQL has no `ORDER BY`); a missing id has no row. `target` is the first of `redirect_to`, `redirect` and `merged_into` that is a non-empty string after trimming spaces, then `superseded_by` when the lower-cased `status` holds the word `alias`, `redirect` or `redirected`. `BODY` is the first 65,536 code points of `compiled_truth`, spaces trimmed; `body_chars` is its length in code points, `body` its md5 hex for an id in `bodyIds` with at least 200 code points, `lead` its first 4,000 code points for an id in `bodyIds`. The TypeScript member refuses an id that is not a 32-bit integer, as the SQL casts both lists to `int[]`. It reads pages, not facts; it sits here because its `BrainEngine` capability class is `facts`. |
| `listFenceRetireCandidates`, `listFenceFactRows` | The fence guard's two reads of a page's fence rows (`facts/fence.rs`): the rows a publication would retire, and the live rows the writer may not supersede. See "The fence guard's reads". |
| `migrateFactsToCanonical` | Moves a phantom page's active rows onto the canonical slug, `row_num` offset past the canonical page's largest. The ontology duplicates the move would make are dropped first, in its own write, as PGLite runs the two statements outside one transaction. |

Rows go out with dates as microsecond ISO text, `embedding` as a number list (or null), and the
stored `trust_tier` and `write_origin`. Every write of a fact row (insert, update, supersede, rename,
purge) stamps them through `trust::stamp` from the store's write trust context
([trust.md](trust.md#the-tier-stamp-truststamp), [write_trust.md](write_trust.md)), as PGLite's
`gbrain_stamp_trust_tier` trigger does; a record written before the field existed reads `unknown`. `fact_fingerprint` follows `gbrain_fact_fingerprint` (lowercase, fold the
fingerprint punctuation, collapse spaces, sha256 hex).

## Private-provenance policy (`facts/privacy.rs`)

`excludePrivate` on `listFactsByEntity`, `listFactsSince`, `listFactsBySession`,
`listFactsKeyset`, `listSupersessions`, `findTrajectory`, `listUnattributedFacts` and the
ontology reads hides a row the way PGLite's `privateProvenanceFilterUnderPolicy('facts')`
(`src/core/search/private-visibility.ts:959`) does with no caller record. PGLite adds it at
`src/core/engine-sql/facts.ts:67` (`privacyClause`), used at lines 443, 472, 511, 539, 567 and
729; at `src/core/review-lists.ts:30`; and as `privateFactFilterForReader('facts')`
(`private-visibility.ts:1021`) at `src/core/pglite-engine.ts:2225` and `:2269`. Rules, each from
the PGLite text it copies (lines in `src/core/search/private-visibility.ts` unless named). The page
reads `getRecentSalience`, `getSalienceScores` and `findAnomalies` apply the same reader and privacy checks to
their own page (`page_hidden`; see [salience.md](salience.md#private-pages-excludeprivate)):

| Rule | Source |
|---|---|
| A row is hidden when its provenance page (`source_markdown_slug`, same source) fails the reader check or the privacy check. A row with no page is kept. | `privateFactFilterForCaller`, 1012; `privatePagesFilterForCaller`, 631 |
| The entity page and, for a row with an entity, the holding page (`memory/unattributed` or `…/memory/unattributed`) must pass the reader check; with `entityPrivacy` they must pass the privacy check too. | `privateEntityFilterForCaller`, 984 |
| The shared-held ruling is always passed with no caller record. | `sharedHeldRuledSql`, 996; `callerRelaxesPrivacy`, 1026; `processPrivacyRelaxed`, 1137 |
| Reader check: a page whose frontmatter has a `readable_by` key is hidden. A page of a plain type passes; any other type passes only when `gbrain_access_origin_restricted` is false. | `privatePagesFilterForCaller`, 631; `gbrain_access_origin_restricted`, `src/core/schema-migrations/v305-access-lineage-designs.ts:42` |
| `gbrain_access_origin_restricted`: an atom whose `source_slug` page names readers; a question or synthesized concept with a `concept-provenance` / `synthesized_from` input that names readers or whose `source_slug` page does; a `life-chronicle` event whose `event.depth` page names readers; then any `derived_from` page that names readers. | `v305-access-lineage-designs.ts:42-77` |
| Privacy check: the snapshot passes, the derived origin is not private, and the declared lineage is not private. | `privacyPartSql`, 89 |
| Snapshot: `visibility` (a derived page defaults to private, others to world) must be `world`, `pinned_question` must not be true, and with `honorAliases` an absent `visibility` with an `access` or `confidentiality` alias (`PRIVACY_ALIASES`, 777; trimmed of edge space, lowercased) is private. | `privateSnapshotFilterFragment`, 707; `privacyAliasSql`, 791; `honorAliases`, 816; `derivedPageSql`, 68 |
| Derived origin: an atom whose `source_slug` page is explicitly private; a derived page with an input whose `visibility` (atom default private) is not world, or whose input origin is explicitly private; a `life-chronicle` event whose `event.depth` is missing, has no page, or names a private page (fail closed). | `derivedOriginPrivateSql`, 733 (the `gbrain_concept_inputs_private` form from `CONCEPT_INPUTS_PRIVATE_SINCE` = 311, `src/core/schema-migrations/v311-concept-inputs-private.ts:23`); `chronicleOriginNotVisibleSql`, 759 |
| Declared lineage: any `derived_from` slug (string or array, `.md` stripped, nulls skipped) whose page is explicitly private. | `declaredLineagePrivateSql`, 687 |

The member sends `{ honorAliases, entityPrivacy }` only when the policy text PGLite would render
now equals its no-caller rendering (`withoutCallerAccess`, 443), the concept-input branch
compared as one token. A caller whose member pages, grants or lineage design widen the text is
refused with `engine_capability_missing` (`src/core/rust-engine/store-members/private-provenance.ts`).

Aliases and renames: each origin slug of the origin rule (atom `source_slug`, concept input
`source_slug` under the input's source, chronicle `event.depth`, each `derived_from` slug) also
names the slug its `slug_aliases` row resolves to and every slug its `slug_rename_history` rows
moved it to (`gbrain_access_origin_restricted`, v305). The atom-origin probe adds the `rename`
alias (`atomOriginSlugsSql`, 24) and the rename history (`atomMovedOriginPrivateSql`, 34, #8920)
of `src/core/persistence/atom-origin.ts`. Both come from `aliases.rs` (`read_slug_alias`,
`renamed_to`), which `updateSlug` fills as `rename-alias.ts` does.

## Vectors (`facts/embedding.rs`)

`facts.embedding` is `halfvec(N)` in PGLite, with N the `embedding_dimensions` config value
(1536 when unset). The member sends the literal PGLite inlines (`'[a,b,...]'`). The store reads it
as pgvector's `vector_in` does (each element an `f32`; `NaN not allowed in vector`,
`infinite value not allowed in vector`, `vector must have at least 1 dimension`), checks the width
(`expected N dimensions, not M`) and rounds each element to the nearest `f16`, ties to even
(`"<float4 text>" is out of range for type halfvec` past 65504). These checks run before the
`NOT NULL` checks, as the cast does in the INSERT.

A row with a vector gets `embedded_at` now and the input's `embedding_model`.
`embedded_text_hash` is `md5(fact)` only when the model is a non-empty text. A vector with no
model is kept with no model and no hash; PGLite raises no error for it. The `FactRecord` holds the
vector as hex `f16` bit patterns, four digits an element (`embedding`, absent when null). Cosine
distance follows `halfvec_cosine_distance`: `f32` sums, the similarity in `f64`, clamped to
[-1, 1]; a zero vector gives NaN. `md5` is computed in place (no hash crate carries it).

## Keys

Every key starts with `keys::FACT` (`F`) and a tag byte. Text parts end with `\0`. The id
counter is `M next_facts_id`.

| Key | Value | Meaning |
|---|---|---|
| `F 0x01 id` | `FactRecord` (JSON) | One fact row. `id` is 8 big-endian bytes, so key order is id order. |
| `F 0x02 source id` | empty | Rows of a source. |
| `F 0x03 source entity id` | empty | Rows about an entity. |
| `F 0x04 source source_markdown_slug id` | empty | Rows of a page. |
| `F 0x05 source source_markdown_slug row_num` | id | `idx_facts_fence_key` (unique). |
| `F 0x06 target referrer` | empty | `superseded_by` back-links, so a deleted row clears its referrers (`ON DELETE SET NULL`). |
| `F 0x07 source entity dimension value_hash source_markdown_slug valid_from` | id | `idx_facts_ontology_stint_dedup` (unique). |
| `F 0x08 id` | `LoopRecord` (JSON) | One `open_loops` row. Its counter is `M next_open_loops_id`. |
| `F 0x09 source dedup_key` | id | `open_loops_dedup` (unique). |

## Lookups and hooks for other families

- `read_fact`, `write_fact`, `delete_fact` (`pub(crate)`): row access for the ontology family.
  `write_fact` refuses a unique key another row holds with `23505`.
- `fact_exists(read, id, source_ids)`: true when fact row `id` exists in one of `source_ids`
  (any source when the list is empty). Eval capture uses it for a `facts/<id>` slug, which
  stays on a captured candidate while the fact row does (`insertEvalCandidate` in
  `src/core/feedback/store.ts`). As in PGLite, an expired, superseded or consolidated row
  still exists, and so does a row whose page was soft-deleted. The caller checks the slug
  against `^facts/[0-9]{1,18}$` first.
- `remove_source_rows` (`cascade::remove_source_rows`): deletes every fact of a deleted
  source, as `facts_source_id_fkey ... ON DELETE CASCADE` does.
- `rename_slug_rows` (`cascade::rename_slug_rows`): the facts half of PGLite's
  `moveSlugBindings`, in its order. The fact-withdrawal move has nothing to move: only
  `executeRaw` writes `fact_withdrawals`, and the Rust engine refuses it. Then the ontology
  duplicates of the entity move are dropped, `entity_slug` moves, the rows at the new page
  whose `row_num` the old page holds are deleted, the ontology duplicates of the page move are
  dropped, and `source_markdown_slug` moves.

## Group 5: doctor checks (`facts/doctor.rs`)

Ten members back the doctor checks. Eight are served by `facts/doctor.rs`; two refuse in the
TypeScript store member with `engine_capability_missing`, and the three unlinked-fact reads
refuse their `hasAttempts: true` form.

| Member | Rust | Missing data when refused |
|---|---|---|
| `listConversationFactRows` | served | |
| `countRedactedFacts` | served | |
| `listOutsideContentFenceCounts` | served | |
| `countAtomFacts` | served | |
| `listUnpreviewedTrustFacts` | refused | no store read yet: the store keeps the write-gate holds and the `facts.trust_tier` and `facts.write_origin` columns it reads |
| `countUnlinkedFactsByOrigin` | served for `hasAttempts: false` | `hasAttempts: true` reads the `fact_relink_attempts` table |
| `countUnlinkedFactStats` | served for `hasAttempts: false` | `hasAttempts: true` reads the `fact_relink_attempts` table |
| `countFactRelinkOutcomes` | refused | the `fact_relink_attempts` table |
| `listUnlinkedConversationSlugs` | served for `hasAttempts: false` | `hasAttempts: true` reads the `fact_relink_attempts` table |
| `countFactEmbeddingCoverage` | served | |

- With no attempts table nothing was tried or paid, so the served unlinked reads return
  `conversation_tried`, `conversation_paid`, `no_subject` and `conversation_unresolved` as 0,
  and only the `relink` fix targets rows.
- `countFactEmbeddingCoverage` treats `fact_withdrawals` as empty (the same stance as
  "Lookups and hooks"): the Rust engine refuses `executeRaw`, the only writer of a withdrawal.
  A fact is `partial` when its text is over 8000 UTF-16 units and the row is not stale.
- The window reads sort by `created_at DESC` then `id DESC`; PGLite leaves a tie in
  `created_at` unordered. Rows come sorted by source id (and origin or slug) where PGLite's
  `GROUP BY` order is unspecified.
- `listOutsideContentFenceCounts` reads fence rows from the `facts`, `takes` and `links`
  indexes; a fact counts only with a `row_num` and `source_markdown_slug`, so only `insertFacts`
  rows are seen.

## Group 5: command, cycle and fence reads (`facts/cycle.rs`)

Each member is one store call (a scan of the fact rows, no SQL). The TypeScript statements live in
`src/core/engine-sql/facts-cycle.ts`; `Pg` and `PGLite` run them, the store answers the same rows.

| member | what it answers | served or refused |
| --- | --- | --- |
| `listActiveFactsForEntity` | an entity's unexpired, unlapsed facts, highest confidence then newest id first, at most `limit` | served |
| `listFreshExtractionOutcomes` | the unexpired `audit:` rows of named pages, the preferred source first within a page | served (exact ties break by id) |
| `listFenceRowGroups` | per page coordinate with fenced rows (no `cli:` rows): row numbers and whether all are expired | served (no set order) |
| `readFactSubject` | a fact's source and page slug (its page, else its entity), or null | served |
| `listFactsForPage` | the fence-owned rows of a page by row number then id; times come back as `Date`s | served |
| `countLegacyFactsPending` | per entity page, the unexpired unfenced non-observation rows of a live page in a source with a checkout | served (no set order) |
| `countUnconsolidatedFactsBySource` | the consolidate buckets of at least `minPerBucket` active unconsolidated facts | served; "names readers" is a page whose frontmatter has `readable_by` (the folder-rule tables and `page_readers` are empty, as in `privacy.rs`) |
| `findBulkFactDays` | the bulk days of unarchived sources under a `rule`, with top sources and self-dated claims | served; refused when a count threshold is not an integer or the share is not finite |
| `maxFenceRowNum` | the largest `row_num` of a page coordinate, 0 for none | served |
| `listStoredFenceFactRows` | the numbered rows of a page coordinate, oldest id first | served |
| `countWorldFacts` | the entity card's unexpired fact count under its visibility and privacy | served; a trust floor (`eligibility.floor`) and `suppressFlagged` apply `trust::TrustPolicy` to the fact's stamped tier and its write-gate receipts; refused for `excludePrivate` when the caller's rendering is not the store's policy. Deleted and quarantined pages are always hidden, and `needs_rederive` is treated as empty, as in `takes.rs` |

## Group 5: purge, withdrawal, relink and fence repair (`facts/purge.rs`)

SQL in `src/core/engine-sql/facts-purge.ts`; each member sends the arguments of its `BrainEngine`
member. Dates go out as microsecond ISO text. A fact's fingerprint is `fact_fingerprint` (the same
normalization as `gbrain_fact_fingerprint`). An audit checkpoint row (a terminal or non-extractable
`source` with `EXTRACTION_COMPLETE` or `EXTRACTION_NOT_APPLICABLE` as the fact) is never a purge target,
plan row or leftover. An unbacked entity is an entity slug with no `/` and no live page of the source.

| Member | What it does |
|---|---|
| `countFactFingerprintLeftovers` | Rows of the source with the fingerprint, checkpoint rows apart, that `visibility` and `subject` (`*` is every entity) do not cover. A row with no entity is left only by another visibility. |
| `loadPurgeTarget` | The row `id` of the source (not a checkpoint row) with `fact_hash` and `embedding` as vector text (`float4_out`). A fractional id is `invalid_argument`; an id no row can have answers null. |
| `planFactPurgeIds` | `[{ id }]` of one visibility with the fingerprint, in id order: the subject's rows (all with `*`) and every unbacked-entity row. |
| `listRelinkCandidateRows` | Active rows of the source with no entity and no fence key (`row_num`, `source_markdown_slug`) after `afterId`, from `since` when set, in id order, at most `limit`. |
| `countRelinkCandidates` | Active no-entity rows of the source that hold a fence key. |
| `listSimilarActiveFacts` | `{ anchor, rows }`: the anchor's `has_embedding` and entity (null for an unknown id), then, when it has a vector, the other active rows of its entity and visibility with the same `embedding_model` and cosine at least `minCosine`, nearest first then by id, at most `limit`. `remote` keeps world rows. `excludePrivate` takes the store's privacy policy and refuses a caller whose policy widens it. A NaN similarity goes out as the string `NaN`; vectors of different lengths are `invalid_argument`. |
| `findActiveSingleFact` | The lowest-id active row with the same entity (null matches null), visibility, fingerprint and speaker slot (a null speaker on either side matches) on `pageSlug`, or, with a null `pageSlug`, on no owned memory page; an empty `pageSlug` matches nothing. The row has every column of `SELECT *`. Refuses with `remoteFloor`. |
| `listUnfencedFactRows` | Active rows with no fence key and no `dimension`, of one source or all, by source, entity (bytewise, no entity last) and id, with `page_exists` (a live page of the entity). |
| `listHeldFenceFactRows` | A page's active fence rows by `row_num` then id, less rows whose `source` starts with `cli:extract-conversation-facts`. |
| `listWithdrawalSlugs` | Sorted distinct `COALESCE(source_markdown_slug, entity_slug)` of the active rows with the fingerprint and visibility that the subject covers: `*`, the subject's entity, an unbacked-entity row unless the subject is an owned memory page, or a row on that page. |
| `expireFactsByWithdrawal` | The write: stamps `expired_at` now and `valid_until` at the lesser of its value and now on the same rows (by the text's fingerprint) and answers `[{ id }]` in id order. Run it on the engine, outside a transaction. |

`SELECT *` rows (`findActiveSingleFact`) carry the stored `trust_tier` and `write_origin`, and null for
the columns the store has not got: `source_window`, `last_written_at` and the `write_*` and
`last_write_*` columns.

Refused with `engine_capability_missing`: `listFactsReconcileBacklog` (its reconcile ledger table
`page_facts_reconcile` is not in the store) and `listSingleFactMetadata` (no store read yet: the
store keeps the `trust_tier` it reads; it also reads the remote floor).

## Group 5: repair classifiers and loop retirement (`facts/repair.rs`)

Ten members (`src/core/engine-sql/facts-repair.ts`). Four read only `facts` and `pages` and are served; six read a
table the store does not hold and refuse with `engine_capability_missing` (they are absent from
`store-members/facts-repair.ts`, so the capability named in `members.ts` is `facts`).

| Member | What it answers | Rust |
| --- | --- | --- |
| `listSessionFactsForClassification` | Active, unsuperseded facts of the capture lanes whose attribution is the user or unset, optionally only the named ids, by (source, id). | Served |
| `listSessionFactTwins` | For each named fact: whether an owner twin exists outside the lanes and the sessions of its lane twins (`twin_sessions`: distinct, `''` for no session, in text order). By id. | Served |
| `listCapturedFactsForClassification` | The same lane facts with their fingerprint and `legit_twin` (another non-expired fact of the source with the same visibility, entity and fingerprint outside the lanes). By (source, id). | Served |
| `listWorldFactsFromPrivateSources` | Active `world` facts held in, or extracted from, a page that is private by `visibility`, a privacy alias or `readable_by`, with `readable`. By id. | Served |
| `loopFactDrift` | Closed loops whose commitment fact is still active. | Refused: needs `open_loops` |
| `closedLoopWithActiveFact` | One closed loop whose commitment fact is still active. | Served from `facts/loops.rs`: a `done` or `dropped` loop whose fact exists with no `expired_at` |
| `countLabelFacts` | The bounded count of evidenced label facts. | Refused: needs `open_loops` and `fact_withdrawals` (it also matches a regular expression with `~*` over page text) |
| `listExtractorFactsForClassification` | Expired fenceless extractor facts with page, withdrawal, duplicate, fence and receipt evidence. | Refused: needs `persistence_requests` and `fact_withdrawals` |
| `countPurgedPageFacts` | The bounded count of facts of a purged page, by class. | Refused: needs `page_purges`, `fact_withdrawals` and `open_loops` |
| `listUnwithdrawnFacts` | Facts a facts-fence generation retired that no withdrawal covers. | Refused: needs `derived_generations`, `derived_generation_items` and `fact_withdrawals` |

Rules of the four served members:

- Sources are visited in byte order of their id and a source's rows in id order, which is
  `ORDER BY f.source_id, f.id` under the C collation the parity brains use. The two id-keyed reads
  (`listSessionFactTwins`, `listWorldFactsFromPrivateSources`) answer by id; an id with no fact answers
  nothing.
- A fact's fingerprint is `gbrain_fact_fingerprint`. `IS NOT DISTINCT FROM` on `entity_slug` is plain
  equality of the optional text. `COALESCE(source, '') <> ALL(lanes)` is "not in a lane"; with no lanes every
  fact is outside and none is inside.
- `listWorldFactsFromPrivateSources` derives privacy from the page, not from a setting the store holds: the
  `provenance` page is the one `factProvenanceSlugSql` names (a `put_page:` or `sync:` session, else the first
  word of `context` for a page source, one trailing `.md` removed), read in the fact's own source and only when
  not deleted. The holding page counts when not deleted. A page is private when `visibility` is `private`
  (an absent one is private on an atom, a question or a synthesized concept), it has a `pinned_question` key, it
  has a privacy alias value (`access`, `confidentiality`; trimmed and lower-cased), or it has `readable_by`.
  `readable` is false only for a held page the snapshot filter hides. Whether an alias hides a page with no
  `visibility` is a process setting; the TypeScript member reads it from the rendered filter and passes it as
  `honorAliases`.
- A folder rule is never read: the store holds no access tables, so no page is folder-restricted.
- The privacy helpers (`provenance_slug`, `snapshot_allows`, `alias_private`, `derivation_private`) are
  re-implemented in `repair.rs` rather than shared with `privacy.rs`.

## Group 5: search relevance and trust reads (`facts/trust.rs`)

| Member | Site | Served | Notes |
|---|---|---|---|
| `listFactsForRelevance` | `search/fact-relevance.ts` | keyword and entity arms | The pool predicate and `similarity` are below. `entity_ended` refuses (it reads `fact_withdrawals` and `gbrain_fact_fingerprint`). |
| `countUncomparableFacts` | `search/fact-relevance.ts` | yes | Per source, the most first, then by source id. |
| `matchSavedFacts` | `search/saved-facts-match.ts` | refused | Reads `trust_tier` (`trustRankSql`). |
| `readFactForOwnerAction` | `trust/owner-actions.ts` | refused | `trust_tier` is hashed into the owner binding. |
| `listStandingPreferences` | `trust/review.ts` | refused | Reads `trust_tier`, `write_gate_receipts` and the `sources` claim state. |
| `listLexicalContestCandidates` | `trust/supersede-handlers.ts` | refused | Filters on the trust-tier rank. |
| `listRestatedPrivateCopies` | `trust/supersede-handlers.ts` | refused | Filters on the trust-tier rank. |
| `countDerivedFactTaint` | `trust/taint.ts` | refused | Reads `write_origin` and `trust_tier`. |

The pool predicate (`poolWhere`), clause by clause: the source list; unless `includeExpired`, `expired_at`
and `superseded_by` NULL and `valid_until` NULL or in the future; no audit checkpoint source; the row's
provenance page carries no `quarantine` key (a soft-deleted page still counts, as the SQL does not read
`deleted_at`); `worldOnly`; the private-provenance policy under `excludePrivate`; a soft-deleted entity or
provenance page hides the row; then the entity, session, `since` (on `valid_from`) and `grep` filters.

- A `minTrust` floor and `suppressFlagged` apply `trust::TrustPolicy` to the fact's stamped tier and its
  write-gate receipts, as the SQL's trust floor and suppression clauses do. The `needs_rederive` anti-join is not modelled, so no row is hidden by it (the
  takes family does the same).
- `similarity` is `1 - cosine distance` for a row whose vector has the query's model and length and whose
  `embedded_text_hash` is `md5(fact)`, else NULL. Distances are `f32` sums as `facts/embedding.rs`
  computes them, so values equal PGLite's to about 1e-6, not bit for bit. A `vector`-typed (not
  `halfvec`) column and a non-`english` FTS language refuse in the member.
- `countUncomparableFacts` keeps SQL's three-valued logic: with an undeclared column width a row counts
  only when a conjunct of the comparable test is false, so a vector with a NULL model is not counted.
- `listFactsForRelevance` serves the pool reads only. Its caller `collectFactCandidates` still makes
  other reads on the way (the word stems, the facts embedding column, the named-entity anchor and the
  nearest-vector arm); on Rust each of those is served or refused by the family that owns it.

## Open loops (`facts/loops.rs`)

The `open_loops` table, for the three members loops-store.ts calls through the engine and the
`loops_close` retry read `closedLoopWithActiveFact`. The other loop statements (thread auto-close,
the staleness pass, mutes and the other loop-fact reads) still run through `executeRaw`, so they
refuse on this engine.

| Member | What it does |
|---|---|
| `upsertOpenLoop` | Inserts a loop, or updates the row with the same `(source_id, dedup_key)`. The update runs only when the row is open, the new activity is newer, or `closed_by` is `mute_recheck`; and only when `closed_by` is not `muted` or the counterparty email changed. It keeps `thread_id` and `detector`, keeps the old slug, email, page, due time and fact id when the new one is NULL, and keeps the old counterparty source when the new slug is NULL. An open row keeps its earlier `opened_at`; a reopened row takes the new one. Returns `{ id, created, applied }`. |
| `listOpenLoops` | The rows that pass the source list, status, type, counterparty (slug in the counterparty source, or email) and id filters, by `last_activity_at` descending, then id descending, at most the clamped limit. |
| `closeOpenLoop` | Closes an open row (in the named source when one is given) with a status, `closed_by` and now. NULL when no open row matches. |
| `closedLoopWithActiveFact` | `{ id, status, fact_id }` of a `done` or `dropped` row (in the named source when one is given) whose fact exists with no `expired_at`; NULL otherwise, also for a row with no fact. |

- Every upsert takes an id from the counter, also one that lands on an existing row, as `nextval`
  does before `ON CONFLICT`. A refused upsert (a CHECK value, an unknown source) rolls back and takes
  none, where Postgres keeps the gap. No member exposes the gap.
- `loop_type`, `detector` and the close `status` refuse with `constraint_violation` when the table's
  CHECK list does not hold them. The close status is checked only when a row matches, as the
  `UPDATE` checks only the rows it writes.
- `confidence` is the `real` column: it is kept as `f32` and read back as its shortest text.
- `evidence` is kept in jsonb key order.
- Times: the store reads `YYYY-MM-DDTHH:MM:SS[.ffffff]Z`. The member rewrites an ISO time with an
  offset and at most 3 fractional digits through `Date#toISOString`. It sends any other spelling (a
  bare date, a time with no zone) as written, and the store refuses it with `invalid_argument`, where
  Postgres would read it in the session time zone.
- Deleting a source removes its loops (`ON DELETE CASCADE`).

## The fence guard's reads (`facts/fence.rs`)

Two reads of one page's fact rows, for the page publication path (`engine-sql/facts.ts`
`listFenceRetireCandidates`, `engine-sql/trust-fence.ts` `listFenceFactRows`). Both read the page's
rows through the by-page index, keep the rows at a fence position (`row_num` set), and compare each
with the incoming fence: a JSON array of `{ row_num, fact, visibility }` cells. A cell field that is
absent or null equals nothing, as SQL `=` does. A document that is not an array of objects, or a
`row_num` that is not an integer, refuses with `invalid_argument` (PGLite's `jsonb_to_recordset`
raises).

- `list_fence_retire_candidates`: the before-state (`FACT_PREIMAGE_SQL`'s keys, the times as the
  `jsonb` text `2026-06-18T09:00:00.5+00:00`) of each row the incoming fence does not hold at the
  same number, fact and visibility, in row number then id order, expired rows included. A
  conversation-extractor row (`source` starting `cli:extract-conversation-facts`) is a candidate
  only when a cell claims its number. A private row that `open-facts` opens in place is not.
- `list_fence_fact_rows`: the live (`expired_at` null) rows under the same filters that are more
  trusted than the writer (`above`), held narrower by a widening proposal, or opened (`opened`):
  `{ id, row_num, fact, visibility, trust_tier, above, opened }`, by row number.

What PGLite reads from the transaction, the store takes as a `FenceContext`: the writer's tier
(`gbrain.write_trust_tier`, undeclared reads as `unknown`, a name that is no tier ranks 0) and the
opened ids (`gbrain.write_open_facts`). Both napi members take it from the store's write trust context
(`Store::fence_context`, [write_trust.md](write_trust.md)), which the engine's transaction sets.
`above` compares the row's stored tier with the writer's. A row is held when it is not `world`, a
cell at its number with its fact asks for `world`, and a `confirm` or `supersede_fact` proposal
names it as the related fact, is `pending`, `rejected` or `undone`, and has a `visibility` key in its
before state (`trust::proposals::held_narrower`, [trust.md](trust.md#trust-proposals-trustproposals)).

## Not modeled

The withdrawal ledger and the insert/update guards that read it, and the write-attribution trigger. Inputs whose PGLite outcome the store cannot
reproduce refuse in the member with `engine_capability_missing`.
