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
| `listSupersessions` | Superseded rows, newest supersession first. With a read eligibility (`eligible`, `minTrust`, `suppressFlagged`) it applies `projectionEligibleSql('facts')`: it also hides a row whose live provenance page is quarantined, a row below the trust floor and, under suppression, a flagged agent-written-or-lower row (`trust::TrustPolicy`). The store keeps no `needs_rederive` queue, so that clause hides nothing. |
| `countUnconsolidatedFacts`, `getFactsHealth` | Counts of active rows (and the five entities with the most). |
| `findCandidateDuplicates` | The recency arm: active same-entity rows, newest first, capped by `k`. The keyword arm (`keyword`, `factText`): the same rows less audit checkpoints, kept when `to_tsvector('english', fact)` matches the OR of the claim's `plainto_tsquery` lexemes (`keyword::or_of_lexemes`; none matches nothing), ordered by `ts_rank_cd` descending, then `created_at` and `id` descending. The cosine arm (`embedding`, no `keyword`): the same rows less audit checkpoints, kept when comparable (a vector from `embeddingModel`, `embedded_text_hash = md5(fact)`, the query's width), ordered by `halfvec` cosine distance to the query (cast to `halfvec` too; NaN last; equal distances by id). The keyword arm with an `embedding` keeps only the comparable rows and does not read the vector. An `embedding` with no (or an empty) `embeddingModel` finds nothing. The member refuses the keyword arm when `GBRAIN_FTS_LANGUAGE` is not `english`. |
| `consolidateFact` | Stamps `consolidated_at` and `consolidated_into`. |
| `findTrajectory` | Typed claims and events of an entity, oldest first, world rows only for remote callers. A point carries its `embedding` only when its `embedding_model` is the `embedding_model` config value and its `embedded_text_hash` is `md5(fact)`; otherwise null. |
| `listUnattributedFacts` | The review-list read of `src/core/review-lists.ts`: active rows with no `entity_slug` in any of `sourceIds` (duplicates read once), less rows whose page or entity page is soft-deleted, `worldOnly` keeping `visibility = 'world'`, newest id first, then `offset` and `limit`. Each row is `id, fact, kind, visibility, source_id, created_at, source`, `created_at` in the `timestamptz::text` form (`2026-06-18 09:00:00.5+00`). `excludePrivate` applies the private-provenance policy below, as `src/core/review-lists.ts:30` does. The `BrainEngine` member `listUnattributedFacts` (`src/core/rust-engine/store-members/facts.ts`) calls it in place of the SQL of `src/core/engine-sql/cli-reads-ops.ts`; its `excludePrivateProvenance` becomes this policy. |
| `pageCollapseFacts` | The collapse-stage read of hybrid search (`facts/collapse.rs`, SQL in `src/core/engine-sql/search-reads.ts`): one `{ id, target, body_chars, body, lead }` row per page row whose id is in `ids`, soft-deleted pages and every source included, by id (the SQL has no `ORDER BY`); a missing id has no row. `target` is the first of `redirect_to`, `redirect` and `merged_into` that is a non-empty string after trimming spaces, then `superseded_by` when the lower-cased `status` holds the word `alias`, `redirect` or `redirected`. `BODY` is the first 65,536 code points of `compiled_truth`, or of the stored `truth_lead` for a segmented page (`coalesce(compiled_truth, truth_lead)`), spaces trimmed; `body_chars` is its length in code points, `body` its md5 hex for an id in `bodyIds` with at least 200 code points, `lead` its first 4,000 code points for an id in `bodyIds`. The TypeScript member refuses an id that is not a 32-bit integer, as the SQL casts both lists to `int[]`. It reads pages, not facts; it sits here because its `BrainEngine` capability class is `facts`. |
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
| A bare name key (an `entity_slug` with no `/`) is also hidden when the page at `<dir>/<key>` fails the reader or privacy check, for each directory of `NAME_KEY_PAGE_DIRS` (people, companies, hosts, projects, concepts, funds, orgs, organizations). | `NAME_KEY_PAGE_DIRS`, `src/core/entities/basename-dirs.ts` |
| The shared-held ruling is always passed with no caller record. | `sharedHeldRuledSql`, 996; `callerRelaxesPrivacy`, 1026; `processPrivacyRelaxed`, 1137 |
| Reader check: a page whose frontmatter has a `readable_by` key is hidden. A page of a plain type passes; any other type passes only when `gbrain_access_origin_restricted` is false. | `privatePagesFilterForCaller`, 631; `gbrain_access_origin_restricted`, `src/core/schema-migrations/v305-access-lineage-designs.ts:42` |
| `gbrain_access_origin_restricted`: an atom whose `source_slug` page names readers; a question or synthesized concept with a `concept-provenance` / `synthesized_from` input that names readers or whose `source_slug` page does; a `life-chronicle` event whose `event.depth` page names readers; then any `derived_from` page that names readers. | `v305-access-lineage-designs.ts:42-77` |
| Privacy check: the snapshot passes, the derived origin is not private, and the declared lineage is not private. | `privacyPartSql`, 89 |
| Snapshot: `visibility` (a derived page defaults to private, others to world) must be `world`, `pinned_question` must not be true, and with `honorAliases` an absent `visibility` with an `access` or `confidentiality` alias (`PRIVACY_ALIASES`, 777; trimmed of edge space, lowercased) is private. | `privateSnapshotFilterFragment`, 707; `privacyAliasSql`, 791; `honorAliases`, 816; `derivedPageSql`, 68 |
| Derived origin: an atom whose `source_slug` page is explicitly private; a derived page with an input whose `visibility` (atom default private) is not world, or whose input origin is explicitly private; a `life-chronicle` event whose `event.depth` is missing, has no page, or names a private page (fail closed). | `derivedOriginPrivateSql`, 733 (the `gbrain_concept_inputs_private` form from `CONCEPT_INPUTS_PRIVATE_SINCE` = 311, `src/core/schema-migrations/v311-concept-inputs-private.ts:23`); `chronicleOriginNotVisibleSql`, 759 |
| Declared lineage: any `derived_from` slug (string or array, `.md` stripped, nulls skipped) whose page is explicitly private. | `declaredLineagePrivateSql`, 687 |

The member sends `{ honorAliases, entityPrivacy }` when the policy text PGLite would render
now equals its no-caller rendering (`withoutCallerAccess`, 443), the concept-input branch
compared as one token. The store knows two fact forms: `privateProvenanceFilterUnderPolicy` (the
fact lists, the relevance pool and `listSimilarActiveFacts`) and `privateFactFilterForCaller` (what
`privateFactFilterForReader` renders for a caller that is not the owner: `countWorldFacts` and the
ontology reads). With no caller the two are the same policy in a different order.

Every fact family opts in with `callerReaders`: a caller whose text equals the rendering for a
record of only its reader identity and private-readable grant is served, and the member sends
`identity` and `privateReadableSources`. The entity gate (`page_hidden` on the entity page) reads
both. The provenance gate reads neither, with one exception in the first form: its member-page CASE
judges the caller's own member page (`memory/members/<member>`, the actor's member or the first
`member:` principal) with the identity. The member then sends that slug as `memberPage`, and
`hidden_by_private_provenance` reads the identity on that page only (`provenance_identity`). The
second form has no CASE and sends no `memberPage`. Any other caller (folder rules, audiences,
lineage, labelled-only members) is refused with
`engine_capability_missing` (`src/core/rust-engine/store-members/private-provenance.ts`). A keyed-slug entity
(an `entity_slug` with no `/`) is judged at the name-key page directories (`NAME_KEY_PAGE_DIRS`) by
`facts/privacy.rs`, as `privateEntityFilterForCaller` does.

A page read under `excludePrivate` sends the page policy (`storePagePolicy`). A page family that opts in with
`callerReaders` also sends the caller's reader identity and private-readable grant, when the caller's text equals
the rendering for a record of only those two fields. `page_hidden` then lets a page whose `readable_by` names one of
the identity's principals pass the member-access part (`access_readers`, the twin of `gbrain_access_readers` in
migration v282: trimmed of edge spaces and ASCII lower-cased, a bare id read as `member:<id>`, a malformed value read
as `!nobody`), and a page of a granted source that is not a pinned question pass the privacy part
(`orPrivateReadableSource`). The fact policy sends them as described above.

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
| `F 0x0A source fact_id` | `AttemptRecord` (JSON) | One `fact_relink_attempts` row (primary key `(source_id, fact_id)`). `fact_id` is sign-flipped big-endian, so key order is numeric order. |
| `F 0x0B source tier target_slug fact_id` | empty | Attempts that carry both a tier and a target page, for `deleteFactRelinkMemos` and the paid memo read. |

### Relink attempts (`facts/relink.rs`)

`upsertFactRelinkAttempt` writes one row per `(source, fact)`; a second write replaces every
column and stamps `attempted_at` with the store clock. With `keepModelAndRun`, a conflict keeps
the stored `model` and `run_id` (a first write stores the given ones). The row has no foreign
key, as in Postgres: deleting a fact or its page leaves the attempt in place, and the source
check is the caller's. `listFactRelinkOutcomes` answers in fact-id order. The doctor's unlinked
reads use the attempts as memos: a row is tried when its attempt is `conversation_unresolved`,
unless a page created in the source after the attempt re-arms a NULL or re-armed reason
(`REARMED_REASONS` in `facts/conversation-memo.ts`, passed in by the TypeScript member); it is
paid when a `paid_reextract` attempt for its page has the page's current `content_hash` as its
reason. `countFactRelinkOutcomes` counts `no_subject` rows and the `linked` rows of the last 7
days by outcome and tier.

### Relink writes (`facts/relink_writes.rs`)

`placeRelinkedFact` changes one row of the source that has no place yet (no entity, no fence
key, not expired). `link` sets the entity and the fence key (`source_markdown_slug`, `row_num`)
and the context; `retire` sets the entity, `expired_at` (the store clock) and the context. A
fence position another row holds refuses with `23505` on `idx_facts_fence_key`. A bad `rowNum`
or an unknown action is `invalid_argument`. `linkConversationFact` sets the entity and the
context only while the row is still as planned: on the given page with the given text, live
(not expired, `valid_until` unset or later), with no entity or on the unbacked name key `from`,
user or unattributed, written by a conversation extractor, and the target page is live. Both
return false and write nothing when the row does not match. The withdrawal ledger is modeled: `write_fact` keeps a fact expired when its claim is withdrawn, as the Postgres
insert trigger does. Not modeled: the purge trigger of the Postgres `UPDATE`, because the purge ledger has no Rust writer.

`listConversationRelinkPages` is the page pick of `gbrain facts relink --conversation`. It reads
the source's rows in one snapshot and counts, per `source_markdown_slug`, the live rows written by
a conversation extractor (not an audit row), user or unattributed, with no entity (or, with
`unbacked`, on an unbacked name key). With `skipTried` it leaves out a row whose attempt is a
`conversation_unresolved` miss, unless a newer live page re-armed the reason (`rearmedReasons`,
passed from `REARMED_REASONS` of facts/conversation-memo.ts). Pages sort by count, most first,
then by slug in byte order (COLLATE "C"), and the list stops at `limit`.

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
  `moveSlugBindings`, in its order. It first moves the `fact_withdrawals` of the old subject to the new one
  (`trust::withdrawals::move_subject_in`; a withdrawal the new slug already has keeps its time). Then the ontology
  duplicates of the entity move are dropped, `entity_slug` moves, the rows at the new page
  whose `row_num` the old page holds are deleted, the ontology duplicates of the page move are
  dropped, and `source_markdown_slug` moves.
- `expire_gone_page_facts`: `purgeDeletedPages` calls it in its write, after the page rows are
  removed, as PGLite's `expireGonePageFacts` (`src/core/facts/gone-page-facts.ts`) runs its four
  updates, in their order: facts filed on a purged page, the slot facts of a filed conversation
  (dimension, value and status cleared too), facts extracted from the page by a page-extraction
  source (`mcp:put_page`, `sync:import`, `file_upload`, `code_import`) and filed on no page, and
  facts about the page that no remaining page row holds. A row is expired (`expired_at` now,
  `row_num` cleared), never deleted.

## Group 5: doctor checks (`facts/doctor.rs`)

Ten members back the doctor checks. Eight are served by `facts/doctor.rs`, one
(`listUnpreviewedTrustFacts`) by `facts/trust_reads.rs` (below), and `countFactRelinkOutcomes`
refuses in the TypeScript store member with `engine_capability_missing`. The three unlinked-fact
reads refuse their `hasAttempts: true` form.

| Member | Rust | Missing data when refused |
|---|---|---|
| `listConversationFactRows` | served | |
| `countRedactedFacts` | served | |
| `listOutsideContentFenceCounts` | served | |
| `countAtomFacts` | served | |
| `listUnpreviewedTrustFacts` | served by `facts/trust_reads.rs` | |
| `countUnlinkedFactsByOrigin` | served for `hasAttempts: false` | `hasAttempts: true` reads the `fact_relink_attempts` table |
| `countUnlinkedFactStats` | served for `hasAttempts: false` | `hasAttempts: true` reads the `fact_relink_attempts` table |
| `countFactRelinkOutcomes` | refused | the `fact_relink_attempts` table |
| `listUnlinkedConversationSlugs` | served for `hasAttempts: false` | `hasAttempts: true` reads the `fact_relink_attempts` table |
| `countFactEmbeddingCoverage` | served | |

- With no attempts table nothing was tried or paid, so the served unlinked reads return
  `conversation_tried`, `conversation_paid`, `no_subject` and `conversation_unresolved` as 0,
  and only the `relink` fix targets rows.
- `countFactEmbeddingCoverage` leaves out a fact a withdrawal covers, as `eligibleFactEmbedding` does (the row's
  source and visibility, either fingerprint, subject `*` or the row's entity, or only the page's own slug on a member
  page). Unlike the write-time guard it gives an unbacked name key no extra subjects.
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
| `countWorldFacts` | the entity card's unexpired fact count under its visibility and privacy | served; a trust floor (`eligibility.floor`) and `suppressFlagged` apply `trust::TrustPolicy` to the fact's stamped tier and its write-gate receipts; `excludePrivate` serves a caller with a reader identity and a private-readable grant (`callerReaders`) and refuses any other caller whose rendering is not the store's policy. Deleted and quarantined pages are always hidden, and `needs_rederive` is treated as empty, as in `takes.rs` |

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
| `listSimilarActiveFacts` | `{ anchor, rows }`: the anchor's `has_embedding` and entity (null for an unknown id), then, when it has a vector, the other active rows of its entity and visibility with the same `embedding_model` and cosine at least `minCosine`, nearest first then by id, at most `limit`. `remote` keeps world rows. `excludePrivate` takes the store's privacy policy, serves a caller with a reader identity and a private-readable grant (`callerReaders`, with the member-page CASE) and refuses any other caller whose policy widens it. A NaN similarity goes out as the string `NaN`; vectors of different lengths are `invalid_argument`. |
| `findActiveSingleFact` | The lowest-id active row with the same entity (null matches null), visibility, fingerprint and speaker slot (a null speaker on either side matches) on `pageSlug`, or, with a null `pageSlug`, on no owned memory page; an empty `pageSlug` matches nothing. The row has every column of `SELECT *`. `remoteFloor` takes the store's privacy policy with `provenanceOnly` (`remoteProvenanceFloorSql`: the provenance page, `source_markdown_slug`, alone, judged with the empty identity, and no entity or holding-page gate); a labelled-only caller or an owner read, whose floor differs, refuses. |
| `listUnfencedFactRows` | Active rows with no fence key and no `dimension`, of one source or all, by source, entity (bytewise, no entity last) and id, with `page_exists` (a live page of the entity). |
| `listHeldFenceFactRows` | A page's active fence rows by `row_num` then id, less rows whose `source` starts with `cli:extract-conversation-facts`. |
| `listWithdrawalSlugs` | Sorted distinct `COALESCE(source_markdown_slug, entity_slug)` of the active rows with the fingerprint and visibility that the subject covers: `*`, the subject's entity, an unbacked-entity row unless the subject is an owned memory page, or a row on that page. |
| `expireFactsByWithdrawal` | The write: stamps `expired_at` now and `valid_until` at the lesser of its value and now on the same rows (by the text's fingerprint) and answers `[{ id }]` in id order. Run it on the engine, outside a transaction. |

`SELECT *` rows (`findActiveSingleFact`) carry the stored `trust_tier` and `write_origin`, and null for
the columns the store has not got: `source_window`, `last_written_at` and the `write_*` and
`last_write_*` columns.

`listFactsReconcileBacklog` is served from the `page_facts_reconcile` watermark (`facts/reconcile.rs`, key
`F 0x0D page_id`): a live page is due when it has no watermark row or its `reconciled_revision` is not its
`knowledge_revision`. The rows are the due pages whose body or timeline holds `FACTS_FENCE_BEGIN` (the member sends
it; a plain substring match, as the SQL's `LIKE` is for that marker) or that own a fence row of their source
(`row_num` set, expired or not), with `invalid` when the latest attempt was `invalid` at the current revision, in
(source, slug) byte order (the SQL pins `COLLATE "C"`). `segmented` counts the other due pages with a NULL body.

`settleFactsReconcile` and `selectFactsReconcileDrain` write the watermark (`facts/reconcile.rs`).
`settleFactsReconcile` records one live page's outcome when `anyRevision` is set or `revision` is the page's
`knowledge_revision`, and records nothing otherwise (a moved-on, soft-deleted or missing page). `complete` sets the
reconciled revision and time; any other outcome keeps them. The attempted revision is the page's current one, and the
attempt time is now. An outcome outside `complete`, `deferred`, `invalid` and `cancelled` refuses with
`invalid_input`, as the table's CHECK does. `selectFactsReconcileDrain` runs in one write: it settles as `complete`,
in page-id order and at most `settleLimit`, the source's due live pages whose body and timeline are present and lack
the marker and that own no fence row; then it answers at most `pageLimit` slugs of the source's other due live pages
that are not `invalid` at their current revision, never-attempted first, then oldest attempt, then page id. A hard
page delete removes the page's row (`cascade::remove_page_rows` calls `facts::reconcile::remove_page_rows`, the
`ON DELETE CASCADE`); a soft delete keeps it. `lockReconcileRevision` answers whether the live page `(sourceId, slug)`
is at `revision` (`facts/reconcile.rs`); a soft-deleted or missing page, or a null revision, answers false. Postgres
locks the row `FOR SHARE` for the rest of the transaction. Once a store transaction is served on Rust (a later landing; `engine.transaction` is a typed refusal in this landing), the
read runs inside the caller's store transaction and sees its writes; that transaction holds the store's single writer from
begin to commit, so no other writer changes the page before the settle commits. Outside a transaction it reads the last
commit.
`listSingleFactMetadata` is served by `facts/trust_reads.rs` (below), except under the remote provenance floor.

## Group 5: repair classifiers and loop retirement (`facts/repair.rs`)

Ten members (`src/core/engine-sql/facts-repair.ts`). Nine are served: four read only `facts` and `pages`, the two loop
reads come from `facts/loops.rs`, `countLabelFacts` reads facts, pages, loops and withdrawals, `countPurgedPageFacts`
also reads the `page_purges` ledger (`facts/page_purges.rs`, key `F 0x0C source \0 content_hash`) and
`listUnwithdrawnFacts` reads the derived generation ledger (`facts/generations.rs`, key `F 0x0E generation_id`). One
reads a table the store does not hold and refuses with `engine_capability_missing` (it is absent from
`store-members/facts-repair.ts`, so the capability named in `members.ts` is `facts`).

No member writes the derived generation ledger on Rust. The fence writer (`publishFenceGeneration` in
`generations/fence.ts`, through `activateGeneration` and `recordHeld` in `generations/publish.ts`) writes it with raw SQL
in the page write's transaction, and a managed source journals the activation (`generations/managed.ts`, the write
journal), so both stop on the typed `raw_sql` refusal and `listUnwithdrawnFacts` lists nothing on Rust. A writer that
binds the ledger must also delete a source's generations with the source. The store also keeps no
`version_history_gap_at` (`page-state/versions.ts` sets it with raw SQL), so `history_gap` is always false.

No member writes `page_purges` on Rust. Its two writers, the page purge sweep (`persistence/page-purge.ts`) and the
restore replay (`belief/purge-mirror.ts`), write it with raw SQL inside the write journal's transaction, so they stop on
the typed `raw_sql` refusal and the Rust ledger stays empty: every fact `countPurgedPageFacts` counts on Rust is
ambiguous. A writer that binds the ledger must also add `F 0x0C` to the source cascade and give `putPage` the
`purged_content` guard of the Postgres pages trigger.

| Member | What it answers | Rust |
| --- | --- | --- |
| `listSessionFactsForClassification` | Active, unsuperseded facts of the capture lanes whose attribution is the user or unset, optionally only the named ids, by (source, id). | Served |
| `listSessionFactTwins` | For each named fact: whether an owner twin exists outside the lanes and the sessions of its lane twins (`twin_sessions`: distinct, `''` for no session, in text order). By id. | Served |
| `listCapturedFactsForClassification` | The same lane facts with their fingerprint and `legit_twin` (another non-expired fact of the source with the same visibility, entity and fingerprint outside the lanes). By (source, id). | Served |
| `listWorldFactsFromPrivateSources` | Active `world` facts held in, or extracted from, a page that is private by `visibility`, a privacy alias or `readable_by`, with `readable`. By id. | Served |
| `loopFactDrift` | Closed loops whose commitment fact is still active. | Served from `facts/loops.rs`: a `done` or `dropped` loop of the named sources whose fact is in its own source with no `expired_at` and no `open` loop references it, by id |
| `closedLoopWithActiveFact` | One closed loop whose commitment fact is still active. | Served from `facts/loops.rs`: a `done` or `dropped` loop whose fact exists with no `expired_at` |
| `countLabelFacts` | The bounded count of evidenced label facts. | Served: the active facts of `segmentSource` whose context holds the `%text%` of `contextLike`, on a live page whose body or timeline has a line that opens with `**`, a label, any `[[:space:]]` and `:**` (ASCII case folding; `[[:space:]]` is the musl `iswspace` set PGLite reads, where Postgres on glibc also counts U+1680), on a page no active `extractor_version=N`-stamped audit fact decided, unsuperseded and no row's successor, named by no loop and covered by no withdrawal. The store counts up to `cap + 1` and the member caps it. `store-members/label-line.ts` reads the label line into its literal labels; any other pattern, a context pattern other than `%text%` and a cap that is not an integer refuse |
| `listExtractorFactsForClassification` | Expired fenceless extractor facts with page, withdrawal, duplicate, fence and receipt evidence. | Refused: needs the `persistence_requests` receipts of the write journal |
| `countPurgedPageFacts` | The bounded count of facts of a purged page, by class. | Served: the active facts of a page-extraction source (`mcp:put_page`, `sync:import`, `file_upload`, `code_import`) filed on no page, whose context head (the text before the first ` — `) is not empty, holds no `[[:space:]]` (the musl set PGLite reads, where Postgres on glibc also counts U+1680) and names no page row, live or soft-deleted, of the fact's source. A fact counts when its head holds a `/` (ambiguous) or a `page_purges` row of its source names the head at or after its `created_at` (evidenced), and no withdrawal, successor, referring row or loop holds it. The store lists up to `cap + 1` and the member caps and counts them; a cap that is not an integer refuses |
| `listUnwithdrawnFacts` | Facts a facts-fence generation retired that no withdrawal covers. | Served: per fact id the newest `fenceKind` generation of the sources (not `held`, owner `page:<slug>`, `slug` when set) whose retired item has an object preimage with an `id`, a `row_num` and no `expired_at`; listed when the fact, in the same source, is expired, has no `row_num`, has the preimage's `fact` and `visibility` and is not a conversation extractor's. `withdrawn` applies `withdrawalCoversFactSql` to the source's withdrawals at the current fingerprint (the store's only withdrawal writer keys by it, so it holds no v1 key); `active_duplicate` is an active row on the page with the same fingerprint and entity and a compatible attribution. By (source, slug) byte order (the SQL pins `COLLATE "C"`), then id |

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

## Group 5: stamped trust reads (`facts/trust_reads.rs`)

Two reads of the `trust_tier` and `write_origin` the store stamps on every fact row. Neither needs a
key range of its own: they read the fact rows and the write-gate holds (`trust/write_gate.rs`).

| Member | Site | Served | Notes |
|---|---|---|---|
| `listSingleFactMetadata` | `facts/purge.ts` | yes, without the remote floor | `id = ANY(ids)` within `sourceId`: a repeated id answers once and an id no row has answers nothing. The SQL has no `ORDER BY`; the store answers in id order. The member refuses `remoteFloor: true` and an id that is not an `int4`. |
| `listUnpreviewedTrustFacts` | doctor `trust-release-unpreviewed` | yes | Unexpired `user_confirmed` facts whose `write_origin` names the `trust_release` channel and has no `fields_previewed`, each joined to the newest released fact hold with the same source, slug, fence row (`payload->>'row_num'` as text, so `"3"` matches row 3) and request id (`IS NOT DISTINCT FROM`). A fact with no such hold drops out. In id order, at most `limit`; every row carries `total`, the count before the limit. The member refuses a limit that is not a non-negative integer. |

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

The `open_loops` table, for the four engine members (`upsertOpenLoop`, `closeOpenLoop`, `listOpenLoops` and the
entity card read `readEntityOpenLoops`, a TypeScript shim over the list read) and the
`loops_close` retry read `closedLoopWithActiveFact` and the retirement scan `loopFactDrift` (doctor
`loop_facts_drift`, `gbrain repair loop-facts`). The other loop statements (thread auto-close, the
staleness pass and mutes) still run through `executeRaw`, so they refuse on this engine.

| Member | What it does |
|---|---|
| `upsertOpenLoop` | Inserts a loop, or updates the row with the same `(source_id, dedup_key)`. The update runs only when the row is open, the new activity is newer, or `closed_by` is `mute_recheck`; and only when `closed_by` is not `muted` or the counterparty email changed. It keeps `thread_id` and `detector`, keeps the old slug, email, page, due time and fact id when the new one is NULL, and keeps the old counterparty source when the new slug is NULL. An open row keeps its earlier `opened_at`; a reopened row takes the new one. Returns `{ id, created, applied }`. |
| `listOpenLoops` | The rows that pass the source list, status, type, counterparty (slug in the counterparty source, or email) and id filters, by `last_activity_at` descending, then id descending, at most the clamped limit. |
| `closeOpenLoop` | Closes an open row (in the named source when one is given) with a status, `closed_by` and now. NULL when no open row matches. |
| `closedLoopWithActiveFact` | `{ id, status, fact_id }` of a `done` or `dropped` row (in the named source when one is given) whose fact exists with no `expired_at`; NULL otherwise, also for a row with no fact. |
| `loopFactDrift` | `{ loop_id, source_id, fact_id, status, slug }` of each `done` or `dropped` row of the named sources (only `loopId` when given) whose fact is in the row's own source, has no `expired_at`, and no `open` row references; `slug` is the fact's `source_markdown_slug`. By id. |

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
  Postgres would read it in the session time zone. A day the calendar lacks (such as `02-30`) is refused the
  same way, as PGLite refuses it. Postgres reads it as the next valid day (`02-30` becomes `03-02`), because
  postgres.js rolls the date over before the statement is sent, so the Rust engine is stricter than Postgres here.
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
(`Store::fence_context`, [write_trust.md](write_trust.md)), which the direct `applyWriteTrust` call sets. Once the transactions
family lands (a later landing), the engine's transaction will set it; in this landing the engine serves no transaction.
`above` compares the row's stored tier with the writer's. A row is held when it is not `world`, a
cell at its number with its fact asks for `world`, and a `confirm` or `supersede_fact` proposal
names it as the related fact, is `pending`, `rejected` or `undone`, and has a `visibility` key in its
before state (`trust::proposals::held_narrower`, [trust.md](trust.md#trust-proposals-trustproposals)).

## Not modeled

The purge-ledger guards and the write-attribution trigger. Inputs whose PGLite outcome the store cannot
reproduce refuse in the member with `engine_capability_missing`.
