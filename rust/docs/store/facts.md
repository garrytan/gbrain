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
| `listFactsByEntity`, `listFactsSince`, `listFactsBySession` | Filtered lists, newest first, with `limit` and `offset`; `listFactsByEntity` ranks a fact dated in the future by its `created_at`. A `visibility` list without `private` is widened for a member or a private-facts grant (see [Visibility widening](#visibility-widening-factswidenrs)). `grep` is a pre-built ILIKE pattern, folded with Postgres `lower()` one code point at a time. A read eligibility applies as on `listSupersessions` (also on `listFactsKeyset`). |
| `listFactsKeyset` | Oldest first by `(created_at, id)` after a microsecond ISO cursor. |
| (the four list reads) | With a read eligibility (`eligible`, `minTrust`, `suppressFlagged`) each applies `projectionEligibleSql('facts')`, as `listSupersessions` does: it also hides a row whose live provenance page is quarantined, a row below the trust floor and, under suppression, a flagged agent-written-or-lower row. A policy with no floor and no suppression still hides the quarantined page's rows. |
| `listSupersessions` | Superseded rows, newest supersession first. With a read eligibility (`eligible`, `minTrust`, `suppressFlagged`) it applies `projectionEligibleSql('facts')`: it also hides a row whose live provenance page is quarantined, a row below the trust floor and, under suppression, a flagged agent-written-or-lower row (`trust::TrustPolicy`). The store keeps no `needs_rederive` queue, so that clause hides nothing. |
| `countUnconsolidatedFacts`, `getFactsHealth` | Counts of active rows (and the five entities with the most). |
| `findCandidateDuplicates` | The recency arm: active same-entity rows, newest first, capped by `k`. The keyword arm (`keyword`, `factText`): the same rows less audit checkpoints, kept when `to_tsvector('english', fact)` matches the OR of the claim's `plainto_tsquery` lexemes (`keyword::or_of_lexemes`; none matches nothing), ordered by `ts_rank_cd` descending, then `created_at` and `id` descending. The cosine arm (`embedding`, no `keyword`): the same rows less audit checkpoints, kept when comparable (a vector from `embeddingModel`, `embedded_text_hash = md5(fact)`, the query's width), ordered by `halfvec` cosine distance to the query (cast to `halfvec` too; NaN last; equal distances by id). The keyword arm with an `embedding` keeps only the comparable rows and does not read the vector. An `embedding` with no (or an empty) `embeddingModel` finds nothing. The member refuses the keyword arm when `GBRAIN_FTS_LANGUAGE` is not `english`. |
| `consolidateFact` | Stamps `consolidated_at` and `consolidated_into`. |
| `findTrajectory` | Typed claims and events of an entity, oldest first, world rows only for remote callers (widened as in [Visibility widening](#visibility-widening-factswidenrs)). A point carries its `embedding` only when its `embedding_model` is the `embedding_model` config value and its `embedded_text_hash` is `md5(fact)`; otherwise null. |
| `listUnattributedFacts` | The review-list read of `src/core/review-lists.ts`: active rows with no `entity_slug` in any of `sourceIds` (duplicates read once), less rows whose page or entity page is soft-deleted, `worldOnly` keeping `visibility = 'world'`, newest id first, then `offset` and `limit`. Each row is `id, fact, kind, visibility, source_id, created_at, source`, `created_at` in the `timestamptz::text` form (`2026-06-18 09:00:00.5+00`). `excludePrivate` applies the private-provenance policy below, as `src/core/review-lists.ts:30` does. The `BrainEngine` member `listUnattributedFacts` (`src/core/rust-engine/store-members/facts.ts`) calls it in place of the SQL of `src/core/engine-sql/cli-reads-ops.ts`; its `excludePrivateProvenance` becomes this policy. |
| `pageCollapseFacts` | The collapse-stage read of hybrid search (`facts/collapse.rs`, SQL in `src/core/engine-sql/search-reads.ts`): one `{ id, target, body_chars, body, lead }` row per page row whose id is in `ids`, soft-deleted pages and every source included, by id (the SQL has no `ORDER BY`); a missing id has no row. `target` is the first of `redirect_to`, `redirect` and `merged_into` that is a non-empty string after trimming spaces, then `superseded_by` when the lower-cased `status` holds the word `alias`, `redirect` or `redirected`. `BODY` is the first 65,536 code points of `compiled_truth`, or of the stored `truth_lead` for a segmented page (`coalesce(compiled_truth, truth_lead)`), spaces trimmed; `body_chars` is its length in code points, `body` its md5 hex for an id in `bodyIds` with at least 200 code points, `lead` its first 4,000 code points for an id in `bodyIds`. The TypeScript member refuses an id that is not a 32-bit integer, as the SQL casts both lists to `int[]`. It reads pages, not facts; it sits here because its `BrainEngine` capability class is `facts`. |
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
| A bare name key (an `entity_slug` with no `/`) is also hidden when the page at `<dir>/<key>` fails the reader or privacy check, for each directory of `NAME_KEY_PAGE_DIRS` (people, companies, hosts, projects, concepts, funds, orgs, organizations). | `NAME_KEY_PAGE_DIRS`, `src/core/entities/basename-dirs.ts` |
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
`engine_capability_missing` (`src/core/rust-engine/store-members/private-provenance.ts`). A keyed-slug entity
(an `entity_slug` with no `/`) is judged at the name-key page directories (`NAME_KEY_PAGE_DIRS`) by
`facts/privacy.rs`, as `privateEntityFilterForCaller` does.
An anonymous caller on a brain that never named readers (`restricted` false in its
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

The owner-only rule rides on both policies as `ownerOnly`. The member reads it from the rendered text
(`ownerOnlyFormIn`): `fn` when the text holds the `gbrain_owner_only_lineage` call (a recorded schema version of
at least `OWNER_ONLY_LINEAGE_SINCE` = 320, which the CLI's connect gate records on a Rust brain too), `closed` when it
holds the closed `ANY_OWNER_ONLY_SQL` test, and `off` when it holds neither. A policy with no `ownerOnly` field
takes `closed`, the form that hides the most. The store's `fn` form follows the source and the concept inputs only:
`gbrain_owner_only_lineage` also walks `derivation_inputs`, which only raw SQL writes, so a Rust brain has none to walk.

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
`UPDATE` runs, as on every fact write ("The fact purge ledger"). The withdrawal ledger is modeled: `write_fact` keeps a
fact expired when its claim is withdrawn, as the Postgres insert trigger does.

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
| `countStaleFactEmbeddings` | served | the same eligibility as `countFactEmbeddingCoverage`; `chars` counts code points |

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
| `listDerivedRows` | One hop of the derivation walk (`derivedRowsFrom`): the rows derived from a frontier of `{ table, id }` inputs. The store keeps no `derivation_inputs` (`recordDerivationInputs` writes through `executeRaw`, which this engine refuses), so it answers no rows; a NUL in a table or id is `invalid_argument`. |
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
| `listExtractorFactsForClassification` | Expired fenceless extractor facts with page, withdrawal, duplicate, fence and receipt evidence. | Served from `facts/extractor_classify.rs`: the facts of the sources whose `source` starts with `cli:extract-conversation-facts`, expired, with no `row_num`, a `source_markdown_slug` (of `slug` when set) and no `retired: conversation-labels` in `context`. `page_id` / `page_deleted` name the provenance page, live or soft-deleted; `withdrawn` is a withdrawal of the source at the fact's visibility with either fingerprint under `*` or the fact's entity; `active_duplicate` is an active row of the page with the same visibility, fingerprint and entity; `fence_history` is any row of the page from another source. `receipt` / `receipt_consumer` are the `request_id` and `consumer_version` of the write journal's lowest-sequence `committed` request of the page whose `completed_at` is the fact's `expired_at`; the read writes nothing there. `expired_at` is UTC microsecond text. By source id, page slug, id |
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

## Group 5: repair, doctor and write-path sites (`facts/repair_sites.rs`)

Twenty-eight members that were raw `executeRaw` statements in nine callers (`src/core/repair/agent-session-facts.ts`,
`captured-facts.ts`, `facts-rehome.ts`, `src/commands/doctor/checks/fence-integrity.ts`, `facts-pages.ts`,
`unlinked-facts.ts`, `src/core/facts/write-single.ts`, `capture-dedup.ts` and `claim-conflicts.ts`). Each runs the
statement its caller ran, with the same text and parameters, in `src/core/engine-sql/facts-repair.ts` (15),
`facts-doctor.ts` (3) and `facts-trust.ts` (10). None is implemented on Rust yet: each is named `facts` in
`rust-engine/members.ts` and refuses by name with `engine_capability_missing` until the store serves it, so the repair,
doctor and write-path callers stop on that refusal instead of the `raw_sql` refusal they stopped on before.

| Member | Reads or writes | What the store would need |
| --- | --- | --- |
| `listActiveSourceIds`, `listUnarchivedSourceIds` | `sources` | The source ids in byte order; `archived` is false or unset. |
| `readRepairBrainId` | `persistence_brain` | The brain id row, or null (callers fall back to `host`). |
| `listAgentSessionTakeCandidates`, `retireSessionTakes`, `listInactiveTakeIds` | `takes`, `facts` | The `consolidated_into` and `consolidated_at` columns of facts and the take columns `kind`, `holder`, `active`, `resolved_at`, `created_at`. |
| `listSettledSessionFacts`, `reattributeSessionFacts`, `listOtherAttributedFactIds` | `facts` | `attributed_to`, `context`, `superseded_by`, `row_num`; the re-attribution appends its note once and runs in a transaction. |
| `listFenceRewriteRows`, `expireCapturedFacts`, `listExpiredFactIds` | `facts` | `row_num`, `expired_at`, `context`; the expiry puts its context before the fact's own. |
| `listPagelessEntityFacts`, `readEntityRehomeState`, `rehomeEntityFacts`, `listSourceIncarnations` | `facts`, `pages`, `sources` | Live-page lookups by (source, slug), database-only facts keyed by entity, and the source `incarnation` as text. |
| `countSegmentedCensusPages`, `listFactsPageBodies`, `readFactTableCatalog` | `pages`, catalog | `body_storage`, `source_path`, the bounded body prefix, and `to_regclass` of `facts` and `fact_relink_attempts`. |
| `readFactEntitySlugById`, `readSupersessionReplacement`, `linkSupersededFact` | `facts` | Two-fact join for the fence row, same-page test and validity bounds; `superseded_by` link. |
| `listLivePageTitles`, `listPageAliasNames` | `pages`, `page_aliases` | Live titles and normalized aliases; the alias read throws on a brain with no aliases table. |
| `listCaptureDuplicateCandidates`, `computeFactFingerprints` | `facts` | `gbrain_fact_fingerprint`, the member-owned-page exclusion and a numeric scan limit. |
| `listClaimConflictPairs`, `countClaimConflictPairs` | `facts`, `decide_proposals`, `trust_proposals` | Typed claim columns, the as-of bucket, and the proposal tables that exclude a pair already proposed. |

## Group 5: the rest of the facts write and recall sites (not yet in Rust)

Thirty-six members that were raw `executeRaw` statements in seventeen callers (`src/core/facts/absorb-log.ts`, `backstop.ts`,
`embedding-identity.ts`, `slot-tagging.ts`, `subject-infer.ts`, `writeback-settings.ts`, `retire.ts`, `contested-claims.ts`,
`derivation-inputs.ts`, `single-prepare.ts`, `proposal-supersede.ts`, `forget.ts`, `proposal-review.ts`, `fts-index.ts`,
`question-recall.ts`, `src/core/ops/facts.ts` and `src/core/search/fact-relevance.ts`). Seven are in
`src/core/engine-sql/facts-recall.ts` (`readFactsEmbeddingColumn`, `listNearestFacts`, `listSlotRows`, `listPoolUnbackedKeys`,
`listCallOffCueFacts`, `listPoolEntityPairs`, `listFactRowsByIds`) and twenty-nine are in `facts-trust.ts`. Each runs the
statement its caller ran, except `listNearestFacts`, which binds the embedding model, dimensions and vector literal twice
(dimensions once when the column type is declared), so its `$n` numbers differ from the old text. Three are served on Rust,
forget's: `readFactForForget` (`brain.readFactForForget`), and `expireFactSuperseded` and `expireFactAtDate`, which both
call `brain.expireFactUntil` (`expire_fact_until` with `day_or_time` in `crates/gbrain-store/src/facts.rs`). Each other
member is named `facts` in `rust-engine/members.ts` and refuses by name with `engine_capability_missing` until the store
serves it. Two `factWithdrawnRefusal` reads in `single-prepare.ts` are still raw (the withdrawal lane owns them).

| Group | Members | What the store would need |
| --- | --- | --- |
| Write gate | `readPendingWriteReceipt`, `lockSourceShared`, `lockAgentWritebackSetting`, `readMemberPageWithdrawal`, `readFactVisibility`, `readReplacementTarget`, `readPairFactRow`, `readFactActivity`, `readReviewAcceptedMark` | The write-gate receipt, the shared source lock and advisory lock for the writeback setting, member-page withdrawal, fact visibility and the replacement and pair rows. |
| Expiry and supersession | `expireSupersededFact`, `restoreSupersededFact`, `expireFactSuperseded`, `expireFactAtDate`, `expireDerivedFacts`, `deactivateDerivedTakes`, `softDeleteDerivedPages`, `markNeedsRederive` | `expired_at`, `superseded_by` and the derived-row columns; each update runs in the caller's transaction. |
| Provenance and listing | `listOversizedStaleFacts`, `listLivePersonTitles`, `readLiveFactEntityPage`, `listFactsToRetireFromPage`, `listContestedProposalPairs`, `listFactProvenance`, `recordDerivationEdges`, `listDerivedRows`, `readFactForForget`, `readWithdrawalAnchor` | Live-page lookups, the oversized-fact scan cap, derivation edges and the proposal tables. |
| FTS index | `readFactsFtsIndexState`, `swapFactsFtsIndex` | The `facts` full-text index language and its swap. |
| Recall pool | the seven `facts-recall.ts` members | The embedding column, nearest-vector scan, slot rows, unbacked keys, call-off cues, entity pairs and rows by id. |

## Group 5: stamped trust reads (`facts/trust_reads.rs`)

Two reads of the `trust_tier` and `write_origin` the store stamps on every fact row. Neither needs a
key range of its own: they read the fact rows and the write-gate holds (`trust/write_gate.rs`).

| Member | Site | Served | Notes |
|---|---|---|---|
| `listSingleFactMetadata` | `facts/purge.ts` | yes, without the remote floor | `id = ANY(ids)` within `sourceId`: a repeated id answers once and an id no row has answers nothing. The SQL has no `ORDER BY`; the store answers in id order. The member refuses `remoteFloor: true` and an id that is not an `int4`. |
| `listUnpreviewedTrustFacts` | doctor `trust-release-unpreviewed` | yes | Unexpired `user_confirmed` facts whose `write_origin` names the `trust_release` channel and has no `fields_previewed`, each joined to the newest released fact hold with the same source, slug, fence row (`payload->>'row_num'` as text, so `"3"` matches row 3) and request id (`IS NOT DISTINCT FROM`). A fact with no such hold drops out. In id order, at most `limit`; every row carries `total`, the count before the limit. The member refuses a limit that is not a non-negative integer. |

## Withdrawal discovery reads (`facts/withdrawal_discovery.rs`)

`readWithdrawalDiscovery(read)` is the one member `discoverWithdrawalTargets` (`src/core/facts/withdrawal-discovery.ts`)
calls to find every page that carries a withdrawn claim; PGLite and Postgres run the SQL in
`src/core/engine-sql/withdrawal-discovery.ts`. `read.kind` picks the statement. No key range of its own: the store reads
the `F 0x01` fact rows, the page records and, for a segmented page, the live published manifest rows with facts slots
and their segment texts (`page_body::live_facts_slot_rows`).

| Kind | Answer |
|---|---|
| `claim_keys` | Each claim with its subject (`*` for none) and `norm`: `fact_normalize` of its own text, else of the first source fact of its visibility whose fingerprint, then v1 fingerprint, is the claim's hash; null when none. |
| `provenance_pages` | The distinct page ids of the facts of a key's visibility whose fingerprint is the sha256 of `norm` (the key's hash when `norm` is null), for subject `*`, the fact's entity, or the fact's owned memory page (`memory/members/…`, `memory/scope`). The page is `COALESCE(source_markdown_slug, entity_slug)` in the fact's source; a fact whose page was never written answers nothing. |
| `claim_matches` | The distinct `(id, ambiguous)` of the candidates a key matches: no or the same visibility, subject `*` or the candidate's slug, the key's hash equal to the claim's fingerprint or v1. |
| `inline_fence_pages` | Pages after `after` by id, at most `limit`, within `subjects` when given, whose truth or timeline holds `gbrain:facts:` and whose lowered truth or timeline matches every LIKE pattern of a key of their subject (no patterns match). |
| `segment_fence_rows` | Live published rows of segmented pages with facts slots, after `(page, occurrence)`, one of whose whole slots (no `open_start`) matches every pattern of a key; each with its whole slot texts. A slot reads `substring` semantics; text that is not UTF-8 is refused, as `convert_from` is. |
| `split_fence_slots` | Open slots (`open_start`) of those rows grouped by page, region and open start, with the bytes they hold, after `(page, region, open start)`, at most `limit`. |
| `target_pages`, `sample_slugs` | Slug, id and knowledge revision of the given page ids in the source; up to 20 slugs in byte order (Postgres sorts by the database collation). |

No kind filters soft-deleted pages or expired facts, as no statement does. The member
(`store-members/withdrawal-discovery.ts`) refuses a cursor, limit, page id or candidate id that is not a safe integer,
and maps ids to numbers. Pinned by `test/engine-parity/withdrawal-discovery-reads.test.ts`,
`test/withdrawal-discovery-reads-sql-pin.test.ts` and `rust/crates/gbrain-store/tests/withdrawal_discovery.rs`.

## Withdrawal page statements (`facts/withdrawal_pages.rs`)

`recordFactWithdrawal` (`src/core/facts/withdrawal.ts`) calls two members on the pages that carry a withdrawn claim;
PGLite and Postgres run the SQL in `src/core/engine-sql/withdrawal-pages.ts`. No key range of their own: the store
reads and writes page records and deletes the page's `B 's'` embedding signature (`embeddings::clear_signature`).

| Member | Answer |
|---|---|
| `listSegmentedPages(sourceId, slugs)` | `{ id, slug }` of each segmented page (truth and timeline both NULL) at the slugs in the source. |
| `invalidateWithdrawnPages(sourceId, slugs)` | In one store write, each other page at the slugs in the source gets a new knowledge revision and no text projection revision through `write_page` (which queues its projection rebuild, as the revision trigger does), and loses its embedding signature; answers `{ id, slug, knowledge_revision }` of each. |

Each slug counts once, in the order given (`slug = ANY($2)` matches a row once; the SQL has no `ORDER BY`). Neither
member skips a soft-deleted page, as neither statement does. A source id with a NUL byte is refused. The member
(`store-members/withdrawal-pages.ts`) maps ids to numbers. Pinned by `test/engine-parity/withdrawal-forget.test.ts`,
`test/withdrawal-pages-sql-pin.test.ts` and `rust/crates/gbrain-store/tests/withdrawal_pages.rs`.

## Withdrawal check on a malformed fence (`facts/withdrawal_fence.rs`)

`assertPreparedFactWithdrawals` (`src/core/facts/withdrawal.ts`) refuses a prepared import whose malformed facts fence
holds a withdrawn or purged claim. It calls one member; PGLite and Postgres run the SQL in
`src/core/engine-sql/withdrawal-fence.ts`. No key range of its own: the store reads the withdrawal ledger
(`t 0x01`, `trust/withdrawals.rs`) and the purge ledger (`F 0x0F`, `facts/purge_ledger.rs`).

| Member | Answer |
|---|---|
| `hasWithdrawnFenceClaim(sourceId, [{ claim, visibility }], subject)` | Whether a withdrawal or a purge tombstone of the source has the fingerprint or the v1 fingerprint of a claim (`trust::fingerprint`, byte for byte the `gbrain_fact_fingerprint` and `_v1` hex), at the claim's visibility (`private` and `world` when it has none), under subject `*` or `subject` (any subject when `subject` is null). False for no claims. |

Both ledgers match both fingerprints, unlike `isFactWithdrawn`, whose purge half reads the fingerprint only: the SQL
joins the union of `fact_withdrawals` and `fact_purges` on `fact_hash IN (fp, fp_v1)`. With a subject the store reads
two keys per ledger, visibility and hash; with none it scans the `source\0visibility\0` prefix and compares the hash
after the subject. A NUL byte in any text is refused. Pinned by `test/engine-parity/withdrawal-fence.test.ts`,
`test/withdrawal-fence-sql-pin.test.ts` and `rust/crates/gbrain-store/tests/withdrawal_fence.rs`.

## Group 5: search relevance and trust reads (`facts/trust.rs`)

| Member | Site | Served | Notes |
|---|---|---|---|
| `listFactsForRelevance` | `search/fact-relevance.ts` | keyword and entity arms | The pool predicate and `similarity` are below. `entity_ended` refuses (it reads `fact_withdrawals` and `gbrain_fact_fingerprint`). |
| `countUncomparableFacts` | `search/fact-relevance.ts` | yes | Per source, the most first, then by source id. |
| `matchSavedFacts` | `search/saved-facts-match.ts` | yes (`facts/saved_match.rs`) | The match columns, `need`, the cue flag, `trust_rank` and `pool_rank`, as below. The member refuses another correction cue, a non-`english` FTS language and a `worldOnly` read a private-facts grant widens. |
| `readFactForOwnerAction` | `trust/owner-actions.ts` | yes | Served by `facts/trust_owner.rs`: the 16 bound columns in the SELECT's order, the stored tier, null for no fact. |
| `listStandingPreferences` | `trust/review.ts` | yes | Served by `facts/trust_owner.rs`: the `standing_instruction` flag receipts and the source's claim state, with the owner floor and connector kinds the member passes. |
| `listLexicalContestCandidates` | `trust/supersede-handlers.ts` | yes (`facts/contest.rs`) | Active rows of the entity, kind and visibility whose stamped tier ranks above the writer's (a writer that names no tier ranks 0), on `pageSlug` or, without one, on no owned memory page. Highest id first, at most 200; each row is `{ id, fact, trust_tier }`. |
| `listFactsFromQuotedPages` | `search/transcript-quote.ts` | yes (`facts/quote.rs`) | The ids whose holding page, or the page a backstop fact's `source_session` names, has a type in `pageTypes`; a soft-deleted page counts. The store keeps no `derivation_inputs`, so a derived fact is not traced to its inputs. Ascending, each id once. |
| `listOwnerTierFacts` | `search/transcript-quote.ts` | yes (`facts/quote.rs`) | The ids whose stamped tier ranks at or above `floor`; a floor that names no tier answers nothing. Ascending, each id once. |
| `listRestatedPrivateCopies` | `trust/supersede-handlers.ts` | yes | Served by `facts/trust_reads.rs`: the stored tier's rank against the writer's, the lowest id; any active world copy on the entity lifts it. |
| `countDerivedFactTaint` | `trust/taint.ts` | yes | Served by `facts/trust_owner.rs`: `write_origin ? 'taint_inputs'` over every source. |

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
(`Store::fence_context`, [write_trust.md](write_trust.md)), which the direct `applyWriteTrust` call sets. Once the transactions
family lands (a later landing), the engine's transaction will set it; in this landing the engine serves no transaction.
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
foreign key does. `insertHoldingPagePurges({ sourceId, visibility, factHash, requestId, actor, reason, factIds })`
(`facts/holding_purges.rs`) stores that tombstone under each holding page (`memory/unattributed` or a slug ending in
`/memory/unattributed`) that holds one of the listed facts of the source, when the fact names an entity, one per page,
through `insertFactPurge`, so the first row keeps its columns; it answers null. A NUL character, a `requestId` that is
not a UUID or an id that is not a whole number refuses with `invalid_argument` even when no row would be added. `purge_fact`
(facts/purge.ts) writes its main tombstone through `insertFactPurge`; the take and page purges, the purge epoch and the
rest of the purge still run through `executeRaw`, which this engine refuses, so a full `purge_fact` does not run on Rust yet.

Readers: the fence overlay's `purged`; `isFactPurged` (`is_fact_purged`: point reads for subject `*` and the entity)
and the purge half of `isFactWithdrawn` ([trust.md](trust.md)), which every fact writer runs before it saves;
`completeWriteRow`'s `purge_has_facts` (any tombstone of the source; `purge_has_pages` stays false, as the store keeps
no page purges); `readLedgerSource`'s `purgesPossible` (`brain.hasFactPurges`); and `readSourcePurgeFlags`'s `facts`
(`trust/withdrawals.rs` `read_source_purge_flags`, the import overlay's per-source probe). The purge epoch stays 0.

The guard: every fact write (`write_fact`) refuses with `purged_content` (`purged_content: this claim was purged
from this source and cannot be saved again`, the triggers' message) when a tombstone of the row's source and
visibility names its fingerprint under subject `*`, the row's entity, or any subject when the entity is an unbacked
name key. On insert it skips an extraction outcome marker (`gbrain_guard_inserted_facts`); on update it runs when
`fact`, `source_id`, `visibility` or `entity_slug` changed (`gbrain_refuse_purged_fact`). Postgres fires the update
trigger when the statement sets one of those columns, even to the same value; the store fires it only on a change,
which refuses nothing a no-op update would not already have kept. The refusal rolls back the whole write, as the
trigger's exception does. Deleting a source removes its tombstones.

## Conversation fact publication and relink (`src/core/engine-sql/facts-conversation.ts`)

Thirty members, the statements `facts/conversation-publication.ts`, `relink-publish.ts`, `conversation-memo.ts`,
`conversation-relink.ts`, `conversation-entity-hints.ts`, `conversation-incremental.ts`,
`conversation-relink-carry.ts` and `relink.ts` ran as raw SQL. None is served on Rust yet: each is named in
`rust-engine/members.ts` with capability `facts` and stops on the typed `engine_capability_missing` refusal. The data
the store would need:

| Members | What they read or write | What the store needs |
| --- | --- | --- |
| `readNewestConversationFactId`, `countActiveConversationFacts`, `readConversationSlotValueHash`, `maxConversationRowNum`, `listHeldFactSlots`, `countPageConversationFacts`, `countConversationWindowFacts`, `countConversationFactsOutsideWindows` | Counts and keys of a page's conversation facts (`source LIKE 'cli:extract-conversation-facts%'`, `source_markdown_slug`, `row_num`, `source_window`, slot `dimension` and `value_hash`). | The facts rows by (source, page slug), with `source_window` as stored JSON and the `valid_from` of slotted rows. |
| `deleteConversationOutcomeRows`, `clearConversationPageFacts`, `moveConversationSourceWindows`, `stampConversationSourceWindows` | Writes: deletes outcome-marker rows; the five-step clear (delete spent relinked rows, unslot expired rows, expire relinked rows, expire referenced rows, delete the rest); moves and stamps `source_window`. | The write transaction of the page, `open_loops.fact_id` and `facts.superseded_by` references, and the relinked-row test (`RELINKED_DERIVED_ROW`). |
| `listPurgeTombstoneMatches` | The ordinals of a batch whose fingerprint a purge tombstone names, with the unbacked-entity rule. | The fact purge ledger and the pages table (see the fact purge ledger section). |
| `findSpentConversationRequest`, `listConversationBatchRequests`, `readStoredConversationEntry`, `readPrincipalCounters` | Reads of the write journal (`persistence_requests`, `persistence_counters`). | The write journal tables, which the store does not hold; on Rust they would answer empty. |
| `countConversationPagesToExtract`, `listMergedEntityAliases`, `listEntityHintPages`, `lockPageById` | Page reads for the extraction run: pages with no facts yet, slug aliases whose alias page is gone, hint pages (retired and folder-restricted tests), one `FOR UPDATE` page lock. | Pages with `deleted_at`, frontmatter and type, plus the slug alias table. |
| `findSameClaimFenceRow`, `findOntologyTwin`, `readRelinkSource` | Relink publication: a live fence row with the same claim, an ontology twin of a fact (same source, dimension and `value_hash`), and a source's incarnation, archived flag, local path and kind. | Fence rows (`row_num`) and the source row. |
| `factRelinkAttemptsTableExists`, `readReextractOutcomeRow` | The memo: whether the relink attempts table exists, and the outcome row of a page with its content hash. | The relink attempts table, which the store does not hold. |
| `listUnbackedConversationRows`, `listUnlinkedConversationRows`, `listClearedRelinkedFacts`, `countEmbeddedFactsAmong` | Relink reads: active facts naming no page, active facts with no link, expired relinked facts whose entity page is live, and how many named facts hold an embedding. | Facts with visibility, attribution and embedding presence, and live pages by slug. |

## Facts cycle, phantom redirect and fence-guard statements (`engine-sql/facts-cycle.ts`, item 4.2)

Thirty-four members replace the 37 `executeRaw` sites of eight files. Each runs the statement its caller ran at base
`5e22f0c134`, with the same text and parameters (`test/facts-cycle-sites-sql-pin.test.ts` pins both). The Rust engine refuses
each of them with `engine_capability_missing` naming the member until the store serves it, except
`readLiveStoredBody`, which the store serves from `brain.readLivePageBody` (rust/docs/store/write-guards.md)
(`test/engine-parity/facts-cycle-sites.test.ts` is the parity arm). Three members serve two callers each, so 37 sites are
34 members. Data the store needs, by caller:

`cycle/phantom-redirect.ts`
- `listPhantomFactRows(sourceId, slug)` (`movePhantomFacts`): `id` and `row_num` of every fact on the coordinate, no set order.
- `listCanonicalFenceRowNums(sourceId, slug)` (`movePhantomFacts`): the `row_num` values the coordinate's facts hold, nulls left out.
- `moveFactToPage(sourceId, id, slug, rowNum)` (`movePhantomFacts`): sets `entity_slug`, `source_markdown_slug` and `row_num`; a null
  `rowNum` sets `expired_at` to now unless the fact already expired. The facts by-page index and the purge guard apply.
- `repointInboundLinks(phantomId, canonicalId)` and `repointOutboundLinks(phantomId, canonicalId)` (`mergePhantomLinks`): move
  `links.to_page_id` or `links.from_page_id`, skipping a row the canonical page already has with the same `link_type`,
  `link_source` and `origin_page_id` (nulls equal) and a self link. Needs the links table and its identity key.
- `pageHasTimelineEntries(pageId)` (`phantomHasResidue`, and `preparePhantomDelete` in `phantom-redirect-managed.ts`): whether the
  page has one timeline entry; a null page id has none.
- `maxFenceRowNumOfPage(sourceId, slug)` (`tryRedirectPhantom`, and `redirectManagedPhantom` in `phantom-redirect-managed.ts`):
  the largest `row_num` of the coordinate's facts, 0 for none.
- `listRootPageSlugsAfter(sourceId, take, held, after)` (`runPhantomRedirectPass`): live pages of the source with no `/` in the slug,
  not in `held`, past `after`, in byte order of slug, at most `take`. Needs the pages slug index.

`cycle/phantom-redirect-managed.ts` (`preparePhantomMerge`)
- `listOwnLinkIds(pageId)`: ids of links the page starts and owns (`origin_page_id` null).
- `listActiveFactIdsOfPage(sourceId, slug)`: ids of the coordinate's unexpired facts.
- `listFactIdsStillOnPage(ids, slug)`: which of the ids are unexpired and sit on the slug.
- `listLinkIdsOnPage(ids, pageId)`: which of the link ids start at the page.

`facts/unfenced-facts.ts`
- `readPageFileOrigin(sourceId, slug)` (`databaseOnlyPlacement`, and `heldUnmovable` in `facts-home.ts`): `source_path` and
  `source_uri` of the live page, or none. Needs the page's file origin columns.
- `listFenceRowClaims(sourceId, slug)` (`planFence`): `row_num`, `fact` and `source` of the coordinate's fenced facts, no set order.
- `adoptFactIntoFence(sourceId, id, rowNum, slug, fact)` (`fenceFilePage`): sets `row_num`, `source_markdown_slug` and `fact` of one
  fact that still has no `row_num`; any other fact is left alone. The id arrives as text.

`cycle/extract-facts.ts`
- `listFenceRowSupersession(sourceId, slug)` (`syncSupersession`): `id`, `row_num`, `expired_at` and `superseded_by` of the
  coordinate's fenced facts, no set order.
- `setFactSupersededBy(sourceId, id, supersededBy)` (`syncSupersession`): sets or clears `superseded_by`.
- `listHeldWideningFactIds(sourceId, ids)` (`planFenceReconcile`): ids with a `pending`, `rejected` or `undone` `supersede_fact` or
  `confirm` proposal on the facts table whose before state has a `visibility` key (the same rule as `held_narrower` above).
- `expireFactInPlace`, `expireAndDetachFact`, `updateFenceFactCells` (`writeFenceReconcile`): expiry that keeps an existing
  `expired_at`; the same and `row_num` cleared; and one row's cells written (`valid_from` kept when null, `valid_until` kept unless
  `setValidUntil`, `expired_at` cleared when null, else kept if set).
- `listExpirableFactIdsOfDeletedPage(sourceId, slug, pageId)`, `readDeletedPageBody(sourceId, slug)`,
  `expireFactsByIds(sourceId, ids)` (`expireDeletedPageFacts`): unexpired fenced fact ids whose page is soft-deleted (and is the
  given id when one is given); the newest soft-deleted page's `compiled_truth`, `timeline` and `body_storage`; and the ids it
  expired among those still unexpired, at one `now()`.
- `listOntologyObservationSlugs(sourceId)` (`runExtractFacts`): distinct slugs (no `/`) of unexpired facts with a `dimension`.
- `listDeletedPageSlugsWithActiveFacts(sourceId)` (`deletedPagesWithActiveFacts`): distinct slugs of unexpired fenced facts whose
  page is soft-deleted, in byte order.

`facts/facts-home.ts` (`scanFactsHome`)
- `scanUnfencedFactRows(sourceId)`: the unexpired facts with no `row_num`, in entity slug (null first) then id order, with the
  columns the repair adopts, `dimension`, `page_exists` and `page_deleted`.
- `listHeldFactRows(sourceId, days)`: unexpired fenced facts on a holding page (`memory/unattributed` at any depth) that name
  another entity, with `from_slug`, `held_since` (`created_at` as UTC `YYYY-MM-DDTHH:MM:SSZ`) and `old` (older than `days`).
- `listFencedFactsOfMissingPages(sourceId)`: unexpired fenced facts whose live page is missing, by id.

`facts/fence-write.ts`
- `readFenceRowNumHint(sourceId, slug)` (`writeFactsToFence`): the largest `row_num` of the coordinate, 0 for none. The caller keeps
  its `try`/`catch` around it.
- `readSourceCheckoutPath(sourceId)` (`lookupSourceLocalPath`): `sources.local_path`, none for an unknown source.

`facts/file-body-guard.ts`
- `readLiveStoredBody(sourceId, slug, lock)` (`readStoredBody`): the live page's `compiled_truth` and `timeline`; `lock` is the row
  lock the engine's transaction holds. A segmented page reads null columns.
- `listPageStates(sourceId, slug)` (`replaceableFile`): the page row's body, frontmatter, title, type and tags, then the 20 newest
  `page_versions` rows that hold a body, newest first.

`facts/fence-fact-append.ts`
- `countSegmentedVersionsOfPage(sourceId, slug)` (`heldRowsInVersions`): how many of the page's versions are `segmented`.
## Purge, held-move and purge receipt statements (`engine-sql/facts-purge.ts`, Rust engine lane 4 item 4.2)

The statements `facts/gone-page-facts.ts`, `facts/purge-reasons.ts`, `facts/held-fact-move.ts` and
`facts/purge-verify.ts` ran through `executeRaw` are 34 typed members, so the Rust arm answers each with
the typed `raw_sql` refusal until the store holds what it reads. None has a Rust implementation yet; the
parity file `test/engine-parity/facts-purge-sites.test.ts` stops on that refusal for every case, and the
Postgres text of each statement is pinned byte for byte by `test/facts-purge-sites-sql-pin.test.ts`.

| Member | What it does |
|---|---|
| `expireFactsOfGonePages` | Expires the facts a retention purge takes with its deleted pages (filed on them, their conversation slots, extracted from them, about them and held by no page): four updates in order over the paired source ids and slugs. Writes facts; run it in the purge transaction. |
| `readPurgeSourceLocalPath` | The source's checkout path, null for none or no such source. Reads sources. |
| `insertReasonPurgeTombstones` | Tombstones each (commit, path) pair, none twice; the number added. Writes reason_purge_tombstones. |
| `listGitEffectsCarryingReason` | The source's Git effects whose data carries the claim in one of its three forms, in id order, locked for the redaction. Reads persistence_effects. |
| `listPageGitEffectsForStrip` | The slug's Git effects that carry a commit line or trailers, in id order, locked for the strip. Reads persistence_effects. |
| `setPurgeEffectData` | Replaces one effect's data (`effectId` is the bigint id as text). Writes persistence_effects. |
| `listPageChangeReasons` | The change reasons the page's versions and its requests (intent and outcome) recorded, each once, null included. Reads page_versions and persistence_requests. |
| `listRequestsRecordingReasons` | The slug's requests whose intent or outcome records a reason, oldest first (10000 at most). Reads persistence_requests. |
| `heldEntityPageDeleted` | Whether a soft-deleted page holds the slug. Reads pages. |
| `readHeldAccessState` | Whether the access state is readable, an exact page rule covers the entity and a folder rule restricts it. Reads access_rules, access_pending_coverage and the access functions; the caller decides what a failed read means. |
| `heldTargetPageLive` | Whether a live page holds the slug. Reads pages. |
| `listHeldMoveRows` | Every live held row on every holding page of the source, by holding page, entity and id. Reads facts and pages. |
| `listStruckHeldRows` | The struck held rows, one per holding page and row number, none an active fact reuses. Reads facts and pages. |
| `readHeldRowVisibility` | Whether every reader of the source can read the live page; null for no live page. Reads pages and the access rules. |
| `heldMoveDue` | Whether a rule now narrows a held row's entity below its holding page's readers. Reads facts, pages and the access functions. |
| `readHeldConfigValue` | One config row's value, null when unset. Reads config. |
| `readHeldPageLocation` | A live page's file path and URI, null for none; `timeoutMs` ends the read on the server. Reads pages. |
| `readHeldVersionsEdited` | The segmented saved versions a held-fact request recorded as not edited; 0 for none. Reads persistence_requests. |
| `listSegmentedPageBodies` | The source's live pages stored in segments, in id order, `limit` of them. Reads pages. |
| `listSegmentedVersionBodies` | The source's retained versions stored in segments, in id order, `limit` of them. Reads page_versions and pages. |
| `setPurgeProbeTimeout` | Bounds the statements of the transaction it runs in to `ms` milliseconds (set_config, local). |
| `probePurgeDerivations` | One batch of stored derivation results after the cursor (page, pipeline, occurrence): the rows scanned, the claim candidates, those a sweep covers and holds the claim, and those it does not, and the last key. Reads page_segment_derivations and pages. |
| `listBeliefEventsForPurgeProbe` | The next 1000 belief events of the source after id `after` with a recorded value, in id order. Reads belief_events. |
| `listFactContextsForPurgeProbe` | The next 1000 live facts of the source after id `after` that have a context, in id order. Reads facts. |
| `listPageSourcePathsForPurge` | The distinct relative file paths (64 at most) of the pages and their versions, none absolute or climbing out. Reads pages and page_versions. |
| `listNearestFactsForPurge` | The five same-model facts of the source nearest to the embedding, each with whether it contains the claim. Reads facts. |
| `countLegacyDerivedPages` | The source's live atom and dream pages that no derivation edge explains. Reads pages and derivation_inputs. |
| `vacuumPurgedTables` | Compacts the tables a purge touches (query_cache too when asked); rejects when the VACUUM fails. PGLite only: Postgres leaves it to the operator. |
| `listPageProseHits` | The first 20 slugs, in order, of the source's live pages whose text in the store states one of the lowered needles. Reads the store and pages. |
| `readPurgeReceiptSourcePath` | The source's checkout path as the page purge receipt reads it, null for none. Reads sources. |
| `countPagePurgeTombstones` | How many tombstones the page purge left for the slug. Reads page_purges. |
| `readDeletePageRequest` | The newest delete_page request of the source with this request id, null for none. Reads persistence_requests. |
| `listPurgeEffects` | The request's effects in kind order, each with whether any target is parked. Reads persistence_effects. |
| `countPurgeFingerprintResidue` | The facts and takes that still carry the purged claim's fingerprint under the subject (`*` for any), outcome markers apart. Reads facts and takes. |

What the store would need to hold to answer them, by family:

- Gone pages (`expireFactsOfGonePages`): the facts store alone, plus the conversation slot columns and the
  extracted-from-page predicate (`extractedFromPageSql`), run in the purge transaction.
- Purge reasons (`readPurgeSourceLocalPath` to `listRequestsRecordingReasons`): `sources.local_path`, `page_purges` tombstones, the write
  journal's `persistence_effects` (kind, state, request id, `data`) and `persistence_requests` (intent reason),
  and `page_versions.change_reason`.
- Held move (`heldEntityPageDeleted` to `readHeldVersionsEdited`): live and soft-deleted pages, the access policy
  state, rules and pending coverage, the holding-page slug rule, the `config` table and the page file location
  (`source_path`, `source_uri`). These reads end at the sync preparation deadline when called on the planning view.
- Purge receipt (`listSegmentedPageBodies` to `countPurgeFingerprintResidue`): segmented page and version bodies,
  `page_segment_derivations`, `belief_events`, fact contexts and embeddings, `takes`, chunk text, timeline entries,
  the `query_cache` table, and `gbrain_fact_fingerprint` for the residue probe. `vacuumPurgedTables` has no data
  to read: a store with nothing to vacuum answers it as a no-op.

The parity cases seed facts, pages, versions, chunks, timeline entries, write requests and effects through the
typed writers. `belief_events`, `page_segment_derivations` and `takes` have no typed fixture, so their members
are compared on empty data only.

## Fact purge plan, transaction and segment-storage statements (`engine-sql/facts-purge.ts`, Rust engine lane 4 item 4.2)

The statements `facts/purge.ts` ran through `executeRaw` are 35 typed members, so the Rust arm answers each with the
typed `raw_sql` refusal until the store holds what it reads. None has a Rust implementation yet; the parity file
`test/engine-parity/fact-purge-sites.test.ts` stops on that refusal for every case, and the Postgres text of each
statement is pinned byte for byte by `test/fact-purge-sites-sql-pin.test.ts`. One statement of `purge.ts` stays a raw
read: the version-body SELECT of `rewriteVersionBodies` builds its WHERE, column list and lock clause from its two callers
(the purge and the held-fact move), so it has no constant text to type.

| Member | What it does |
|---|---|
| `listStagingPartEdges` | The next 1000 upload parts of the source's live stagings after the (staging, part) cursor, in order, each with its first and last `keep` bytes. Reads page_body_staging_parts and page_body_stagings. |
| `listStagingsHoldingClaim` | The ids of the source's live stagings whose staged segment texts or upload parts hold the claim, plain or as a fence cell stores it, in id order. Reads page_body_stagings, page_body_manifest, page_segment_texts, page_body_staging_parts, page_body_staging_texts and persistence_requests. |
| `purgeSubjectPageLive` | Whether a live page of the source holds the slug (the one-row read that tells a purge the subject is an unbacked name key). Reads pages. |
| `listPurgePagesById` | The slug, id and knowledge revision of the source's pages with these ids. Reads pages. |
| `countPurgeVersionsCarryingClaim` | How many saved versions of the source's pages carry the claim in their text, title, metadata or segments, or quote it in their change reason (`needle` lowered, `escaped` its JSON form, `reason` the folded reason form). Reads page_versions, pages, page_body_manifest and page_segment_texts. |
| `countPurgeReviewRows` | How many review queue, review proposal and decide proposal rows of the source name the facts (`refs` are the ids as text). Reads decide_review_queue, decide_review_proposals and decide_proposals. |
| `listPurgeStreamSlugs` | The distinct belief stream slugs (holding page, else entity) of the facts. Reads facts; run it in the purge transaction. |
| `findPurgeBlockedPublication` | One unfinished write or withdrawal mirror (not the request `ownRequest`) on one of the pages, null for none. Reads persistence_requests and persistence_effects. |
| `listPagesForPurgeRewrite` | The source's pages with these ids, whole rows, each with its tags as `purge_tags`, in slug order. Reads pages and tags. |
| `updatePageBodyForPurge` | Stores a page's body with the purged fence rows dropped, its content hash, and voids its text projection and embedding signature. Writes pages; run it in the purge transaction. |
| `setPurgeVersionBody` | Stores a saved version's two body parts after the purge edit (a null timeline stays null). Writes page_versions; run it in the purge transaction. |
| `redactVersionChangeReasons` | Overwrites the change reason of every saved version of the source's pages that quotes the claim (lowered plain form or folded reason form) with `[purged]`; the ids redacted. Writes page_versions. |
| `listSegmentedVersionsForPurge` | The next 5000 segmented saved versions of the source after id `after` that belong to one of the pages or whose generation holds the lowered claim, in id order. Reads page_versions, pages, page_body_manifest and page_segment_texts. |
| `abortPurgedStagings` | Aborts the uncommitted stagings with these ids; the page ids they belonged to (none for a staging with no page). Writes page_body_stagings; run it in the purge transaction. |
| `deletePurgedStagingParts` | Deletes the upload parts of these stagings; how many. Writes page_body_staging_parts; run it in the purge transaction. |
| `deletePageViewDigests` | Deletes the cached read-view digests of these pages. Writes page_view_digests; run it in the purge transaction. |
| `deleteUnreferencedPurgedTexts` | Deletes the source's segment texts that no manifest row references and that were replaced by the purge (`replaced` are their sha256 digests) or hold the claim, plain or as a fence cell stores it; how many. Writes page_segment_texts; run it in the purge transaction. |
| `listPurgeMatchCandidates` | The first 25 facts of the source whose text contains `text` (case folded), in id order, each cut to 160 characters. Reads facts. |
| `lockPurgeSource` | Locks the source row for the purge transaction and returns its incarnation and archived flag, null for no such source. Reads sources; run it in the purge transaction. |
| `insertHoldingPagePurges` | Stores a purge tombstone for each holding page that holds one of the facts about an entity with no page of its own, none twice. Writes fact_purges; run it in the purge transaction. |
| `insertTakePurge` | Stores the text-free take purge tombstone for the claim fingerprint under the subject, none twice. Writes take_purges; run it in the purge transaction. |
| `deletePurgedTakes` | Deletes the takes with these ids; how many. Writes takes; run it in the purge transaction. |
| `deletePurgeReviewQueue` | Deletes the source's review queue rows naming one of the facts (`refs` are the ids as text); how many. Writes decide_review_queue; run it in the purge transaction. |
| `deletePurgeReviewProposals` | Deletes the source's review proposals naming one of the facts (`refs` are the ids as text); how many. Writes decide_review_proposals; run it in the purge transaction. |
| `deletePurgeDecideProposals` | Deletes the source's decide proposals that supersede or are superseded by one of the facts; how many. Writes decide_proposals; run it in the purge transaction. |
| `deletePurgeTrustProposals` | Deletes the source's trust proposals whose target or related row is one of the facts or takes; how many. Writes trust_proposals; run it in the purge transaction. |
| `deletePurgeOpenLoops` | Deletes the source's open loops on one of the facts; how many. Writes open_loops; run it in the purge transaction. |
| `deletePurgeWriteGateHolds` | Deletes the source's held writes whose fact or claim text has the fingerprint; the ids deleted. Writes write_gate_holds; run it in the purge transaction. |
| `deletePurgeWriteGateReceipts` | Deletes the gate receipts that name one of the facts, takes or held writes (ids as text); how many. Writes write_gate_receipts; run it in the purge transaction. |
| `deletePurgeTakeProposals` | Deletes the source's take proposals whose claim text has the fingerprint; how many. Writes take_proposals; run it in the purge transaction. |
| `blankPurgeCoreEditNotices` | Blanks the base text of the source's core edit notices that quote the lowered fact; how many. Writes core_edit_notices; run it in the purge transaction. |
| `deletePurgedFacts` | Deletes the facts with these ids from the source; how many. Writes facts; run it in the purge transaction. |
| `deletePurgedChunks` | Deletes the chunks of these pages and voids the text projection that certified them; how many pages had chunks deleted. Writes content_chunks and pages; run it in the purge transaction. |
| `listPurgedPageRevisions` | The id, slug and knowledge revision of the source's pages with these ids, in slug order. Reads pages. |
| `insertPurgeEffects` | Queues the withdrawal-mirror, git and embedding effects of the purge request under the source's current incarnation and worktree binding, none twice; `data` is the effect payload. Writes persistence_effects; run it in the purge transaction. |

What the store would need to hold to answer them, by family:

- Plan (`listStagingPartEdges` to `countPurgeReviewRows`, `listPurgeMatchCandidates`): pages and their knowledge
  revisions, saved versions with change reasons and segment manifests, page body stagings with their upload parts and
  staged texts, segment texts, the decide review queue, review proposals and decide proposals, and facts for the text match.
- Purge transaction (`listPurgeStreamSlugs` to `deletePurgeTakeProposals`, `blankPurgeCoreEditNotices`,
  `deletePurgedFacts` to `insertPurgeEffects`): the write journal's requests and effects, the source row lock, page and
  version body writes, fact, take, chunk and tombstone writes (`fact_purges`, `take_purges`), trust and take proposals,
  open loops, write gate holds and receipts, core edit notices, and `gbrain_fact_fingerprint` for the fingerprint matches.
- Segment storage (`abortPurgedStagings` to `deleteUnreferencedPurgedTexts`): stagings and their parts, view digests,
  segment texts and the manifest that references them.

The parity cases seed pages, tags, versions, facts, chunks and write requests through the typed writers. Stagings, takes,
review and proposal rows, gate holds and receipts, open loops, core edit notices and view digests have no typed fixture, so
those members are compared on empty tables only; `insertTakePurge` returns nothing and has no typed reader, so it is compared
by running without error. `insertHoldingPagePurges` is compared by the claim checks that read its tombstones back
(holding-page-purges.test.ts).

## Not modeled

The purge-ledger guards and the write-attribution trigger. Inputs whose PGLite outcome the store cannot
reproduce refuse in the member with `engine_capability_missing`.
