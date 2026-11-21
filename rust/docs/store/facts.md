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
| `listFactsByEntity`, `listFactsSince`, `listFactsBySession` | Filtered lists, newest first, with `limit` and `offset`. A `visibility` list without `private` is widened for a member or a private-facts grant (see [Visibility widening](#visibility-widening-factswidenrs)). `grep` is a pre-built ILIKE pattern, folded with Postgres `lower()` one code point at a time. A read eligibility applies as on `listSupersessions` (also on `listFactsKeyset`). |
| `listFactsKeyset` | Oldest first by `(created_at, id)` after a microsecond ISO cursor. |
| (the four list reads) | With a read eligibility (`eligible`, `minTrust`, `suppressFlagged`) each applies `projectionEligibleSql('facts')`, as `listSupersessions` does: it also hides a row whose live provenance page is quarantined, a row below the trust floor and, under suppression, a flagged agent-written-or-lower row. A policy with no floor and no suppression still hides the quarantined page's rows. |
| `listSupersessions` | Superseded rows, newest supersession first. With a read eligibility (`eligible`, `minTrust`, `suppressFlagged`) it applies `projectionEligibleSql('facts')`: it also hides a row whose live provenance page is quarantined, a row below the trust floor and, under suppression, a flagged agent-written-or-lower row (`trust::TrustPolicy`). The store keeps no `needs_rederive` queue, so that clause hides nothing. |
| `countUnconsolidatedFacts`, `getFactsHealth` | Counts of active rows (and the five entities with the most). |
| `findCandidateDuplicates` | The recency arm: active same-entity rows, newest first, capped by `k`. The keyword arm (`keyword`, `factText`): the same rows less audit checkpoints, kept when `to_tsvector('english', fact)` matches the OR of the claim's `plainto_tsquery` lexemes (`keyword::or_of_lexemes`; none matches nothing), ordered by `ts_rank_cd` descending, then `created_at` and `id` descending. The cosine arm (`embedding`, no `keyword`): the same rows less audit checkpoints, kept when comparable (a vector from `embeddingModel`, `embedded_text_hash = md5(fact)`, the query's width), ordered by `halfvec` cosine distance to the query (cast to `halfvec` too; NaN last; equal distances by id). The keyword arm with an `embedding` keeps only the comparable rows and does not read the vector. An `embedding` with no (or an empty) `embeddingModel` finds nothing. The member refuses the keyword arm when `GBRAIN_FTS_LANGUAGE` is not `english`. |
| `consolidateFact` | Stamps `consolidated_at` and `consolidated_into`. |
| `findTrajectory` | Typed claims and events of an entity, oldest first, world rows only for remote callers (widened as in [Visibility widening](#visibility-widening-factswidenrs)). A point carries its `embedding` only when its `embedding_model` is the `embedding_model` config value and its `embedded_text_hash` is `md5(fact)`; otherwise null. |
| `listUnattributedFacts` | The review-list read of `src/core/review-lists.ts`: active rows with no `entity_slug` in any of `sourceIds` (duplicates read once), less rows whose page or entity page is soft-deleted, `worldOnly` keeping `visibility = 'world'`, newest id first, then `offset` and `limit`. Each row is `id, fact, kind, visibility, source_id, created_at, source`, `created_at` in the `timestamptz::text` form (`2026-06-18 09:00:00.5+00`). `excludePrivate` applies the private-provenance policy below, as `src/core/review-lists.ts:30` does. The `BrainEngine` member `listUnattributedFacts` (`src/core/rust-engine/store-members/facts.ts`) calls it in place of the SQL of `src/core/engine-sql/cli-reads-ops.ts`; its `excludePrivateProvenance` becomes this policy. |
| `pageCollapseFacts` | The collapse-stage read of hybrid search (`facts/collapse.rs`, SQL in `src/core/engine-sql/search-reads.ts`): one `{ id, target, body_chars, body, lead }` row per page row whose id is in `ids`, soft-deleted pages and every source included, by id (the SQL has no `ORDER BY`); a missing id has no row. `target` is the first of `redirect_to`, `redirect` and `merged_into` that is a non-empty string after trimming spaces, then `superseded_by` when the lower-cased `status` holds the word `alias`, `redirect` or `redirected`. `BODY` is the first 65,536 code points of `compiled_truth`, spaces trimmed; `body_chars` is its length in code points, `body` its md5 hex for an id in `bodyIds` with at least 200 code points, `lead` its first 4,000 code points for an id in `bodyIds`. The TypeScript member refuses an id that is not a 32-bit integer, as the SQL casts both lists to `int[]`. It reads pages, not facts; it sits here because its `BrainEngine` capability class is `facts`. |
| `listFenceRetireCandidates`, `listFenceFactRows` | The fence guard's two reads of a page's fence rows (`facts/fence.rs`): the rows a publication would retire, and the live rows the writer may not supersede. See "The fence guard's reads". |
| `listHeldFenceCells` | The fence row lines a caller with world-only fact reads may not see (`facts/held_cells.rs`), member callers and callers with a private-facts grant included. See "Held fence cells". |
| `readFenceOverlayRows` | The fence overlay's read of one page body's world fence rows (`facts/fence_overlay.rs`): page tier, newest row fact tier and flag, held hold, narrower fact. See "The fence overlay". |
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
| Owner-only test (any caller but the owner): in the `closed` form a row is hidden while any source is owner-only; in the `fn` form a row is hidden when its own source is owner-only. The provenance, entity and holding pages pass the page form of the same test (see [page-visibility.md](page-visibility.md#differences-from-pglite)). The member sends the form as `ownerOnly` (`ownerOnlyFormIn`). | `ownerOnlyFactAllowedSql`, `ownerOnlyAllowedSql`; `src/core/access/owner-only.ts` |

The member sends `{ honorAliases, entityPrivacy }` when the policy text PGLite would render
now equals its no-caller rendering (`withoutCallerAccess`, 443), the concept-input branch
compared as one token. The store knows two fact forms: `privateProvenanceFilterUnderPolicy` (the
fact lists, the relevance pool and `listSimilarActiveFacts`) and `privateFactFilterForCaller` (what
`privateFactFilterForReader` renders for a caller that is not the owner: `countWorldFacts` and the
ontology reads). With no caller the two are the same policy in a different order.

A caller read while the config flag `access.restrictions_present` was unset (`CallerAccess.restricted` false)
renders the short member-access form. The member renders its comparison texts under that form and sends
`open: true`. The store then hides every page that names readers, whatever the identity, and runs the origin walk
only when its own flag ([access-flag.md](access-flag.md)) is `'1'`, so a stale flag read fails closed.

Every fact family opts in with `callerReaders`: a caller whose text equals the rendering for a
record of only its reader identity and private-readable grant is served, and the member sends
`identity` and `privateReadableSources`. The entity gate (`page_hidden` on the entity page) reads
both. The provenance gate reads neither, with one exception in the first form: its member-page CASE
judges the caller's own member page (`memory/members/<member>`, the actor's member or the first
`member:` principal) with the identity. The member then sends that slug as `memberPage`, and
`hidden_by_private_provenance` reads the identity on that page only (`provenance_identity`). The
second form has no CASE and sends no `memberPage`. Any other caller (folder rules, audiences,
lineage, labelled-only members) is refused with
`engine_capability_missing` (`src/core/rust-engine/store-members/private-provenance.ts`). The store
has no keyed-slug entity rule (an `entity_slug` with no `/`, judged at a name-key page directory by
`privateEntityFilterForCaller`). An anonymous caller on a brain that never named readers (`restricted` false in its
record, the MCP stdio caller) renders the short member-access form; the member judges a fact read for it under the
restricted rendering, the full form above, which hides the same rows on such a brain. A caller with a member identity
there is judged the same way (`judgeWidenedCaller`): the identity reaches the policy only through a page's
readers, and no page there names readers (`test/engine-parity/unrestricted-fact-list-reads.test.ts`). The page
families share the same step (`page-visibility.md`).

## Visibility widening (`facts/widen.rs`)

The four list reads and `listSupersessions` take `visibility` as a plain list. A list without `private` is widened
per row by `factVisibilitySql` (`src/core/access/member-facts.ts`), and the store applies the same two rules when the
member sends `widen`. `findTrajectory` and the relevance pool (`listFactsForRelevance`, `countUncomparableFacts`) take
`worldOnly` instead; PGLite widens it with the same `factVisibilitySql(['world'])`, and the store keeps a world row or
a private row the same `widen` record admits (`world_admits`):

| Rule | Store test | PGLite text |
|---|---|---|
| Own member page | a private row on `memory/members/<member>`, whose live page names `member:<member>` among its readers (`access_readers`) and passes `memberPagePolicy` (`page_hidden`) | `memberFactAdmitSql` |
| Private-facts grant | a private row of a source in `privateFactSources` that has a page to check (not `unpagedFactSql`: no holding page, or a conversation, hook, sweep, transcript or connector lane) and whose pages keep it private for no reason: no holding, entity or provenance slug under `memory/members/`; the holding and provenance pages (`provenance_slug`) not derivation-private in any row, missing, soft-deleted or quarantined; the entity page not derivation-private | `grantedPrivateFactSql`, `factPagesOpenSql`, `factPageReasons` (`src/core/facts/private-fact-pages.ts`) |

The member (`src/core/rust-engine/store-members/fact-visibility.ts`) sends the list alone when PGLite renders the
bare list. Otherwise it sends `widen` only when the caller's text equals the rendering for a record of just its reader
identity, private-readable grant and private-facts grant (`judgeWidenedCaller`), with `member` the member that
record reads as and `memberPagePolicy` its page policy. Any other caller (an audience, an attested actor whose text
differs, folder rules, a relaxed read) refuses with `engine_capability_missing`. Covered by
`test/engine-parity/fact-visibility-widening.test.ts`, `fact-trajectory-widening.test.ts` and
`fact-pool-widening.test.ts`, which share `fact-widening-fixture.ts`.

A page read under `excludePrivate` sends the page policy (`storePagePolicy`). A page family that opts in with
`callerReaders` also sends the caller's reader identity and private-readable grant, when the caller's text equals
the rendering for a record of only those two fields. `page_hidden` then lets a page whose `readable_by` names one of
the identity's principals pass the member-access part (`access_readers`, the twin of `gbrain_access_readers` in
migration v282: trimmed of edge spaces and ASCII lower-cased, a bare id read as `member:<id>`, a malformed value read
as `!nobody`), and a page of a granted source that is not a pinned question pass the privacy part
(`orPrivateReadableSource`). The fact policy sends them as described above.

The owner-only rule rides on both policies as `ownerOnly` (`OwnerOnlyForm`, owner_only.rs). The member reads it from
the rendered text (`ownerOnlyFormIn`): `fn` when the text holds the `gbrain_owner_only_lineage` conjunct (a recorded
schema version of at least `OWNER_ONLY_LINEAGE_SINCE` = 320, which the CLI's connect gate records on a Rust brain too),
`closed` when it holds the closed `EXISTS` form, and `off` for the owner, whose rendering has no conjunct. The store's `fn` form
follows the source and the concept inputs only: `gbrain_owner_only_lineage` also walks `derivation_inputs`, which only
raw SQL writes, so a Rust brain has none to walk.

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
| `F 0x0F source visibility subject fact_hash` | `PurgeRecord` (JSON: `request_id`, `actor`, `reason`, `purged_at_us`) | One `fact_purges` row (primary key `(source_id, visibility, subject, fact_hash)`); `facts/purge_ledger.rs`. |

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
return false and write nothing when the row does not match. The purge guard of the Postgres
`UPDATE` runs, as on every fact write ("The fact purge ledger"); the withdrawal trigger is not
modeled.

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
  `moveSlugBindings`, in its order. The fact-withdrawal move has nothing to move: only
  `executeRaw` writes `fact_withdrawals`, and the Rust engine refuses it. Then the ontology
  duplicates of the entity move are dropped, `entity_slug` moves, the rows at the new page
  whose `row_num` the old page holds are deleted, the ontology duplicates of the page move are
  dropped, and `source_markdown_slug` moves.

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
| `countStaleFactEmbeddings` | served | the same eligibility as `countFactEmbeddingCoverage`; `chars` counts code points |

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
| `countUnconsolidatedFactsBySource` | the consolidate buckets of at least `minPerBucket` active unconsolidated facts | served; "names readers" is a page whose frontmatter has `readable_by` or that sits under a folder rule or a pending prefix (`folder_restricted`); `page_readers` is empty, as in `privacy.rs` |
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

Refused with `engine_capability_missing`: `listFactsReconcileBacklog` (its reconcile ledger table
`page_facts_reconcile` is not in the store). `listSingleFactMetadata` is served by
`facts/trust_reads.rs` (below), except under the remote provenance floor.

## Group 5: repair classifiers and loop retirement (`facts/repair.rs`)

Ten members (`src/core/engine-sql/facts-repair.ts`). Seven are served: four read only `facts` and `pages`, the two loop
reads come from `facts/loops.rs`, and `countLabelFacts` reads facts, pages, loops and withdrawals. Three read a table the
store does not hold and refuse with `engine_capability_missing` (they are absent from `store-members/facts-repair.ts`,
so the capability named in `members.ts` is `facts`).

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
| `countPurgedPageFacts` | The bounded count of facts of a purged page, by class. | Refused: needs `page_purges` |
| `listUnwithdrawnFacts` | Facts a facts-fence generation retired that no withdrawal covers. | Refused: needs `derived_generations` and `derived_generation_items` |

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
- A page is also private when it sits under a folder (`folderRestrictedSql`): a folder rule of its source is
  stamped on it, or a pending or invalid prefix of its source covers its slug (`folder_restricted`).
- The privacy helpers (`provenance_slug`, `snapshot_allows`, `alias_private`, `derivation_private`) are
  re-implemented in `repair.rs` rather than shared with `privacy.rs`.

## Group 5: stamped trust reads (`facts/trust_reads.rs`)

Two reads of the `trust_tier` and `write_origin` the store stamps on every fact row. Neither needs a
key range of its own: they read the fact rows and the write-gate holds (`trust/write_gate.rs`).

| Member | Site | Served | Notes |
|---|---|---|---|
| `listSingleFactMetadata` | `facts/purge.ts` | yes, without the remote floor | `id = ANY(ids)` within `sourceId`: a repeated id answers once and an id no row has answers nothing. The SQL has no `ORDER BY`; the store answers in id order. The member refuses `remoteFloor: true` and an id that is not an `int4`. |
| `listUnpreviewedTrustFacts` | doctor `trust-release-unpreviewed` | yes | Unexpired `user_confirmed` facts whose `write_origin` names the `trust_release` channel and has no `fields_previewed`, each joined to the newest released fact hold with the same source, slug, fence row (`payload->>'row_num'` as text, so `"3"` matches row 3) and request id (`IS NOT DISTINCT FROM`). A fact with no such hold drops out. In id order, at most `limit`; every row carries `total`, the count before the limit. The member refuses a limit that is not a non-negative integer. |

## Stored provenance (`facts/provenance.rs`)

The `source` each fact row keeps, read by id. context_pack and delta attach it to each fact they
deliver as `provenance` (`ops/facts.ts` `withProvenance`, a fail-soft read).

| Member | Site | Served | Notes |
|---|---|---|---|
| `listFactProvenance` | `ops/facts.ts` `withProvenance` | yes | `id = ANY(ids)` within `sourceId`: a repeated id answers once and an id no row of the source has answers nothing. The SQL has no `ORDER BY`; the store answers in id order. The member refuses an id that is not a safe integer. |

## Quote and slot-history reads (`facts/quoted.rs`)

Four `facts-recall.ts` members serve the reads that decide how a fact or a page reaches a model (`search/transcript-quote.ts`)
and the bare-name page lookup of a slot-history question (`search/slot-history.ts` `entityKeys`). The TypeScript members are
`rust-engine/store-members/facts-quoted.ts`; the napi family is `families/facts_quoted.rs`.

| Member | What the store does |
| --- | --- |
| `listFactsFromQuotedPages(ids, pageTypes, backstopSessions)` | Of `ids`, the facts taken from a page of one of `pageTypes` in the fact's own source: the page `source_markdown_slug` names, or the page a backstop fact's `source_session` names (the first `(source, prefix)` pair whose source is the fact's and whose prefix starts the session; the slug is the rest). A soft-deleted page counts. Ascending ids. The SQL also follows `derivation_inputs` edges to a page; the store keeps no derivation inputs (`recordDerivationEdges` is refused), so that clause finds nothing. |
| `listFactIdsAtTrustFloor(ids, floor)` | Of `ids`, the facts whose stored tier ranks at or above `floor` (`trustRankSql`: a name that is no tier ranks 0; an empty name, a record from before the store kept the column, is `unknown`). A floor that names no tier is refused. |
| `readPageTypesByIds(ids)` | `{ id, type }` of each page id, soft-deleted pages included; an id with no page is absent. |
| `listReadablePageSlugs(sourceId, slugs, scope, limit)` | Of `slugs` in `sourceId`, the pages `pageReadFilter(.., live = true)` admits under `scope` (the chunk reads' page policy: privacy, trust floor and flag suppression, not soft-deleted, not quarantined, a live source), at most `limit`. The scope's own `sourceId` / `sourceIds` do not narrow the read. The SQL has no `ORDER BY`; the store keeps the asked order. |

The TypeScript member of `listReadablePageSlugs` resolves the privacy policy as the chunk reads do (a caller's readers are
allowed) and ignores `requireSafeChunks`, which `pageReadFilter` does not read.
Parity: `test/engine-parity/facts-quoted.test.ts`.

## Group 5: search relevance and trust reads (`facts/trust.rs`)

| Member | Site | Served | Notes |
|---|---|---|---|
| `listFactsForRelevance` | `search/fact-relevance.ts` | keyword and entity arms | The pool predicate and `similarity` are below. `entity_ended` refuses (it reads `fact_withdrawals` and `gbrain_fact_fingerprint`). |
| `countUncomparableFacts` | `search/fact-relevance.ts` | yes | Per source, the most first, then by source id. |
| `matchSavedFacts` | `search/saved-facts-match.ts` | yes (`facts/saved_match.rs`) | The match columns, `need`, the cue flag, `trust_rank` and `pool_rank`, as below. The member refuses another correction cue, a non-`english` FTS language and a `worldOnly` read a private-facts grant widens. |
| `readEntityNewestFacts` | `search/entity-facts.ts` | yes (`facts/saved_match.rs`) | The saved-fact columns plus the collapse columns, newest `valid_from` first, then the highest id, 50 rows at most. The member refuses a `worldOnly` read a private-facts grant widens, and the caller rethrows that refusal instead of reading it as no facts. |
| `matchHeadStems` | `search/saved-facts-match.ts` | yes (`facts/saved_match.rs`) | One row per name head, in input order, with the 1-based indexes of the terms its `to_tsvector` matches by `plainto_tsquery`; a stopword term matches nothing. The member refuses a non-`english` FTS language, and the caller rethrows that refusal instead of reading it as no match. |
| `readFactForOwnerAction` | `trust/owner-actions.ts` | refused | `trust_tier` is hashed into the owner binding. |
| `listStandingPreferences` | `trust/review.ts` | refused | Reads `trust_tier`, `write_gate_receipts` and the `sources` claim state. |
| `listLexicalContestCandidates` | `trust/supersede-handlers.ts` | refused | Filters on the trust-tier rank. |
| `listRestatedPrivateCopies` | `trust/supersede-handlers.ts` | refused | Filters on the trust-tier rank. |
| `countDerivedFactTaint` | `trust/taint.ts` | refused | Reads `write_origin` and `trust_tier`. |

The pool predicate (`poolWhere`), clause by clause: the source list; unless `includeExpired`, `expired_at`
and `superseded_by` NULL and `valid_until` NULL or in the future; no audit checkpoint source; the row's
provenance page carries no `quarantine` key (a soft-deleted page still counts, as the SQL does not read
`deleted_at`); `worldOnly`, widened as in [Visibility widening](#visibility-widening-factswidenrs); the private-provenance policy under `excludePrivate`; a soft-deleted entity or
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
- `matchSavedFacts` reads its own candidates: active rows (a superseded row stays), no audit source,
  `worldOnly`, the private-provenance policy, then `projectionEligibleSql` (a soft-deleted page, a live
  quarantined provenance page, the trust floor). Each term is `plainto_tsquery` on the facts FTS document,
  or a lowered `LIKE` for a CJK pattern; a term with no lexeme and no pattern is dropped. The cue is
  `CORRECTION_CUE` written out as its 20 phrases, each matched case-insensitively between word boundaries
  (the store has no regular-expression engine). `trust_rank` is 0 for a tier name it does not know, as
  `trustRankSql` is.
- `readEntityNewestFacts` reads the named entity slugs in one source: active rows, no audit source,
  `worldOnly` and the private-provenance policy for a remote caller, then `projectionEligibleSql` (a
  soft-deleted page, a live quarantined provenance page, the trust floor). `valid_from` is the timestamptz
  text Postgres prints. The caller collapses copies of one claim before its caps.
- `listFactsForRelevance` serves the pool reads only. Its caller `collectFactCandidates` still makes
  other reads on the way (the word stems, the facts embedding column, the named-entity anchor and the
  nearest-vector arm); on Rust each of those is served or refused by the family that owns it.

## Open loops (`facts/loops.rs`)

The `open_loops` table, for the three members loops-store.ts calls through the engine and the
`loops_close` retry read `closedLoopWithActiveFact` and the retirement scan `loopFactDrift` (doctor
`loop_facts_drift`, `gbrain repair loop-facts`). The other loop statements (thread auto-close, the
staleness pass and mutes) still run through `executeRaw`, so they refuse on this engine.

| Member | What it does |
|---|---|
| `upsertOpenLoop` | Inserts a loop, or updates the row with the same `(source_id, dedup_key)`. The update runs only when the row is open, the new activity is newer, or `closed_by` is `mute_recheck`; and only when `closed_by` is not `muted` or the counterparty email changed. It keeps `thread_id` and `detector`, keeps the old slug, email, page, due time and fact id when the new one is NULL, and keeps the old counterparty source when the new slug is NULL. An open row keeps its earlier `opened_at`; a reopened row takes the new one. Returns `{ id, created, applied }`. |
| `listOpenLoops` | The rows that pass the source list, status, type, counterparty (slug in the counterparty source, or email) and id filters, by `last_activity_at` descending, then id descending, at most the clamped limit. |
| `readEntityOpenLoops` | The shim's entity-card read over `listOpenLoops`: status `open`, the card's slug in its source, slug matches only (an email equal to the slug drops), first `limit` rows in `listOpenLoops` order (newest activity, then newest id), the order the SQL sorts in. |
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

## Held fence cells (`facts/held_cells.rs`)

`list_held_fence_cells({ keys, member, grantSources })` (`engine-sql/cli-reads-ops.ts` `listHeldFenceCells`): which facts-fence
row lines of a page's text a caller with world-only fact reads may not see. get_page, get_chunks, think
and search_exact ask it through `eligibility/stamp.ts` `heldFenceLines` and drop the held lines. A key
is `{ sourceId, slug, rowNum, claim, partial }`: the page, the line's row number (-1 when the line names
none), its claim, and whether a chunk boundary cut it.

The store answers `eligibility/fence-overlay.ts` `heldRowSql`. Over the page's live rows (by-page index,
`expired_at` null), a key is held when a narrower row sits at its row number, or when a narrower row
states its claim and no `world` row states it. A row states a claim when its fact equals it, or, for a
cut claim, contains it (`strpos(fact, claim) > 0`).

A row that is not `world` is narrower unless the member admission (`memberFactAdmitSql`) or the grant
admission (`grantedPrivateFactSql`) takes it. For a
member caller (`callerMember()`) the TypeScript member passes `member: { slug, principal, policy }`: the
caller's page `memory/members/<member>`, its principal `member:<member>`, and its page policy, which
`storePageTextPolicy` reads from `privatePagesFilterForCaller` with the caller's readers (a policy the
store does not render refuses, and every line is held). A `private` row of that page is admitted when
the page is live (`deleted_at` null), its readers (`readable_by`, as `page_readers`) name the principal,
and the policy shows the page (`page_hidden`). Every other page, and every page for a caller with no
member identity, admits nothing.

For a caller with a private-facts grant the TypeScript member passes `grantSources`, the sources of
`privateFactSources()`. A `private` row is admitted when its source is granted, its `source_markdown_slug` is set,
it is not a transcript-lane row (a `source` of the conversation prefix, `hook:writeback`, `hook:compact`,
`sweep:corpus`, `transcript:…` or `connector:…`), none of its holding, entity and provenance slugs is a member page
(`memory/members/…`), and none of those pages keeps its facts private: the stored page row (soft-deleted too) is a
private derivation (`derivation_private`), or, for a page other than the entity page, there is no live row or the
live row carries the quarantine key. A row that a `confirm` or `supersede_fact` proposal with a `visibility` key in
its before state names as the related fact is admitted only when every target copy of those proposals is itself
admitted by the member or grant admission (`trust::proposals::visibility_proposal_targets`). With no grant, a grant
on another source, or a soft-deleted page, the rows stay held.

The answer is `[{ source_id, slug, row_num, claim }]`, one row per distinct
held cell, in first-key order (SQL leaves the order open). A NUL character or a row number outside
`integer` refuses with `invalid_argument`, as Postgres raises for the same parameters. No keys answer
`[]` without a read.

## The fence overlay (`facts/fence_overlay.rs`)

`read_fence_overlay_rows({ sourceId, slug, incoming, hideHeld })` (`engine-sql/cli-reads-ops.ts`
`readFenceOverlayRows`): what `eligibility/fence-overlay.ts` `loadFenceChunkOverlay` reads about the world
fence rows of one page body before chunking, evidence text and remote page reads show them. An incoming row
is `{ row_num, claim, visibility, fp }`; `fp` is the row's hold fingerprint (null skips the hold check).

The answer is one row per incoming row, in incoming order: `{ row_num, page_tier, row_tier, row_flagged,
purged, held, narrower }`. `page_tier` is the live page's stored tier (`unknown` when it has none), null when
no live page has the slug. `row_tier` and `row_flagged` come from the page's fact with the highest id at the
row number, expired facts included, as the SQL reads `facts` with no `expired_at` filter: its stored tier and
whether it is activation-suppressed (`trust::activation_suppressed`); both are null when no fact sits there.
`held` is a `kind = 'fact'` hold of the page with status `held` and the row's fingerprint. `narrower`, with
`hideHeld` only, is the held-cell rule above for an uncut claim over the page's live facts; the TypeScript
member refuses a member caller or a private-facts grant (`engine_capability_missing`), as for `listHeldFenceCells`.
`purged` is whether a fact purge tombstone at the incoming row's visibility names the claim's fingerprint under
subject `*` or the page ("The fact purge ledger"). A NUL character or a row number outside `integer` refuses with
`invalid_argument`. No incoming rows answer `[]` without a read.

## The fact purge ledger

`facts/purge_ledger.rs` keeps `fact_purges` (key `F 0x0F`). `insertFactPurge({ sourceId, visibility, subject,
factHash, requestId, actor, reason })` stores a tombstone and answers true, or false when the key exists
(`ON CONFLICT DO NOTHING`; the stored row keeps its columns). A visibility other than `private` or `world`, a
`requestId` that is not a UUID or a NUL character refuses with `invalid_argument`; a missing source refuses as the
foreign key does. `purge_fact` (facts/purge.ts) writes its main tombstone through this member; the holding-slug
tombstones, the take and page purges, the purge epoch and the rest of the purge still run through `executeRaw`, which
this engine refuses, so a full `purge_fact` does not run on Rust yet.

Readers: the fence overlay's `purged`; `isFactPurged` (`is_fact_purged`: point reads for subject `*` and the entity)
and the purge half of `isFactWithdrawn` ([trust.md](trust.md)), which every fact writer runs before it saves;
`completeWriteRow`'s `purge_has_facts` (any tombstone of the source; `purge_has_pages` stays false, as the store keeps
no page purges); and `readLedgerSource`'s `purgesPossible` (`brain.hasFactPurges`). The purge epoch stays 0.

The guard: every fact write (`write_fact`) refuses with `purged_content` (`purged_content: this claim was purged
from this source and cannot be saved again`, the triggers' message) when a tombstone of the row's source and
visibility names its fingerprint under subject `*`, the row's entity, or any subject when the entity is an unbacked
name key. On insert it skips an extraction outcome marker (`gbrain_guard_inserted_facts`); on update it runs when
`fact`, `source_id`, `visibility` or `entity_slug` changed (`gbrain_refuse_purged_fact`). Postgres fires the update
trigger when the statement sets one of those columns, even to the same value; the store fires it only on a change,
which refuses nothing a no-op update would not already have kept. The refusal rolls back the whole write, as the
trigger's exception does. Deleting a source removes its tombstones.

## Not modeled

The withdrawal ledger and the insert/update guards that read it, and the write-attribution trigger. Inputs whose PGLite outcome the store cannot
reproduce refuse in the member with `engine_capability_missing`.
