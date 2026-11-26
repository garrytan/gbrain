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
| `listSupersessions` | Superseded rows, newest supersession first. With a read eligibility (`eligible`, `minTrust`, `suppressFlagged`) it applies `projectionEligibleSql('facts')`: it also hides a row whose live provenance page is quarantined, a row below the trust floor and, under suppression, a flagged agent-written-or-lower row (`trust::TrustPolicy`). The store keeps no `needs_rederive` queue hides a row a purge marked (`generations/needs_rederive.rs`). |
| `countUnconsolidatedFacts`, `getFactsHealth` | Counts of active rows (and the five entities with the most). |
| `findCandidateDuplicates` | The recency arm: active same-entity rows, newest first, capped by `k`. The keyword arm (`keyword`, `factText`): the same rows less audit checkpoints, kept when `to_tsvector('english', fact)` matches the OR of the claim's `plainto_tsquery` lexemes (`keyword::or_of_lexemes`; none matches nothing), ordered by `ts_rank_cd` descending, then `created_at` and `id` descending. The cosine arm (`embedding`, no `keyword`): the same rows less audit checkpoints, kept when comparable (a vector from `embeddingModel`, `embedded_text_hash = md5(fact)`, the query's width), ordered by `halfvec` cosine distance to the query (cast to `halfvec` too; NaN last; equal distances by id). The keyword arm with an `embedding` keeps only the comparable rows and does not read the vector. An `embedding` with no (or an empty) `embeddingModel` finds nothing. The member refuses the keyword arm when `GBRAIN_FTS_LANGUAGE` is not `english`. |
| `consolidateFact` | Stamps `consolidated_at` and `consolidated_into`. |
| `findTrajectory` | Typed claims and events of an entity, oldest first, world rows only for remote callers (widened as in [Visibility widening](#visibility-widening-factswidenrs)). A point carries its `embedding` only when its `embedding_model` is the `embedding_model` config value and its `embedded_text_hash` is `md5(fact)`; otherwise null. |
| `listUnattributedFacts` | The review-list read of `src/core/review-lists.ts`: active rows with no `entity_slug` in any of `sourceIds` (duplicates read once), less rows whose page or entity page is soft-deleted, `worldOnly` keeping `visibility = 'world'`, newest id first, then `offset` and `limit`. Each row is `id, fact, kind, visibility, source_id, created_at, source`, `created_at` in the `timestamptz::text` form (`2026-06-18 09:00:00.5+00`). `excludePrivate` applies the private-provenance policy below, as `src/core/review-lists.ts:30` does. The `BrainEngine` member `listUnattributedFacts` (`src/core/rust-engine/store-members/facts.ts`) calls it in place of the SQL of `src/core/engine-sql/cli-reads-ops.ts`; its `excludePrivateProvenance` becomes this policy. |
| `pageCollapseFacts` | The collapse-stage read of hybrid search (`facts/collapse.rs`, SQL in `src/core/engine-sql/search-reads.ts`): one `{ id, target, body_chars, body, lead }` row per page row whose id is in `ids`, soft-deleted pages and every source included, by id (the SQL has no `ORDER BY`); a missing id has no row. `target` is the first of `redirect_to`, `redirect` and `merged_into` that is a non-empty string after trimming spaces, then `superseded_by` when the lower-cased `status` holds the word `alias`, `redirect` or `redirected`. `BODY` is the first 65,536 code points of `compiled_truth`, or of the stored `truth_lead` for a segmented page (`coalesce(compiled_truth, truth_lead)`), spaces trimmed; `body_chars` is its length in code points, `body` its md5 hex for an id in `bodyIds` with at least 200 code points, `lead` its first 4,000 code points for an id in `bodyIds`. The TypeScript member refuses an id that is not a 32-bit integer, as the SQL casts both lists to `int[]`. It reads pages, not facts; it sits here because its `BrainEngine` capability class is `facts`. |
| `listFenceRetireCandidates`, `listFenceFactRows` | The fence guard's two reads of a page's fence rows (`facts/fence.rs`): the rows a publication would retire, and the live rows the writer may not supersede. See "The fence guard's reads". |
| `readFactPreimages` | The fact rows adapter's before-state of named facts of one source (`facts/fence.rs`). See "The fence guard's reads". |
| `listHeldFenceCells` | The fence row lines a caller with world-only fact reads may not see (`facts/held_cells.rs`), member callers and callers with a private-facts grant included. See "Held fence cells". |
| `readFenceOverlayRows` | The fence overlay's read of one page body's world fence rows (`facts/fence_overlay.rs`): page tier, newest row fact tier and flag, held hold, narrower fact. See "The fence overlay". |
| `listFenceRowTrust` | The fence-row trust read of recall's query arm and synthesize (`eligibility/stamp.ts` `applyFenceRowTrust`; `facts/fence_overlay.rs`): for each fence row key, the newest live fact's tier, `activationSuppressedSql` flag and `contestedRefSql` ref; an expired fact gives no row. |
| `migrateFactsToCanonical` | Moves a phantom page's active rows onto the canonical slug, `row_num` offset past the canonical page's largest. The ontology duplicates the move would make are dropped first, in its own write, as PGLite runs the two statements outside one transaction. |

Rows go out with dates as microsecond ISO text, `embedding` as a number list (or null), and the
stored `trust_tier` and `write_origin`. Every write of a fact row (insert, update, supersede, rename,
purge) stamps them through `trust::stamp` from the store's write trust context
([trust.md](trust.md#the-tier-stamp-truststamp), [write_trust.md](write_trust.md)), as PGLite's
`gbrain_stamp_trust_tier` trigger does; a record written before the field existed reads `unknown`. `fact_fingerprint` follows `gbrain_fact_fingerprint` (lowercase, fold the
fingerprint punctuation, collapse the `is_pg_space` whitespace list, sha256 hex).

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
second form has no CASE and sends no `memberPage`. A labelled-only caller is served too: the member sends `labelledOnly: { identity, satisfiedRuleIds, member }`, and the
store hides a fact unless it sits on `memory/members/<member>` and that page names `member:<member>` (`own_page_fact`,
`labelledOnlyFactSql`); the entity and holding pages are judged without the labelled-only conjunct, as
`privateEntityFilterForCaller` does. A non-owner caller under `access.members_read_lineage` (ordinary or labelled-only) is served too (row 32e-b-4): the member sends
`provenanceLineage` (`provenance_lineage` in `facts/privacy.rs`) and `callerRecord`, with the record's satisfied rules and pending prefixes.
In the first form (`privateProvenanceFilterUnderPolicy`) the provenance page is judged by `provenance_judge`: the caller's own member page by its
identity and the plain origin rule, any other `memory/members/` page by the empty identity, and every other page by the member's lineage as an
origin (`lineageAccessSql`, `derived` true) and the privacy part. In the second form (`privateFactFilterForCaller`) the provenance part is the plain
no-caller fragment, so lineage changes only the entity gate (the policy's `owner_read`) and the labelled-only conjunct. A labelled-only caller with lineage
reads a fact on its own member page or on a provenance page (the fact's source and slug, a soft-deleted page included) that `page_labelled` passes
(`fact_labelled`, `labelledOnlyFactSql`). An audience whose policy matches none of the reference renderings (including a labelled-only audience of several identities)
is refused with `engine_capability_missing` (row 32e-b-5; `src/core/rust-engine/store-members/private-provenance.ts`). A keyed-slug entity
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
| Private-facts grant | a private row of a source in `privateFactSources` that has a page to check (not `unpagedFactSql`: no holding page, or a conversation, hook, sweep, transcript or connector lane) and whose pages keep it private for no reason: no holding, entity or provenance slug under `memory/members/`; the holding and provenance pages (`provenance_slug`) not derivation-private in any row, missing, soft-deleted or quarantined; the entity page not derivation-private; and not a held row the grant refuses (GST-2979: a visibility proposal names a copy the caller's reads admit by neither rule, along the hold chain; `widen.rs` `hold_refused`) | `grantedPrivateFactSql`, `factPagesOpenSql`, `factPageReasons` (`src/core/facts/private-fact-pages.ts`) |

The member (`src/core/rust-engine/store-members/fact-visibility.ts`) sends the list alone when PGLite renders the
bare list. Otherwise it sends `widen` only when the caller's text matches a fresh reference record of its reader
identity, private-readable grant and private-facts grant, plus the supported labelled-only and lineage fields from
`callerReference`, optionally with its satisfied folder rules and pending prefixes. `member` is the member that
record reads as; `memberPagePolicy` carries its page policy and reference flags. A caller whose text matches none
of these renderings refuses with `engine_capability_missing`. The private-provenance fact gate serves non-owner lineage reads (row 32e-b-4). Covered by
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
takes `closed`, the form that hides the most. The store's `fn` form follows the source, the concept inputs and the
recorded `derivation_inputs`, transitively, as `gbrain_owner_only_lineage` does ("Derivation inputs" below).


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
| `F 0x0C source content_hash` | JSON: `slug`, `request_id`, `purged_at_us` | One `page_purges` row (primary key `(source_id, content_hash)`); `facts/page_purges.rs`. |
| `F 0x0C source content_hash` | `PagePurgeRecord` (JSON) | One `page_purges` row (primary key `(source_id, content_hash)`); `facts/page_purges.rs`. |
| `F 0x0F source visibility subject fact_hash` | `PurgeRecord` (JSON: `request_id`, `actor`, `reason`, `purged_at_us`) | One `fact_purges` row (primary key `(source_id, visibility, subject, fact_hash)`); `facts/purge_ledger.rs`. |
| `F 0x10 source subject claim_hash` | `TakePurgeRecord` (JSON: `request_id`, `purged_at_us`) | One `take_purges` row (primary key `(source_id, subject, claim_hash)`); `facts/take_purges.rs`. Stays at `0x10`. |
| `F 0x11 source kind value` | `SuppressionRecord` (JSON: `id`, `created_at_us`) | One `loop_suppressions` row (unique `(source_id, kind, value)`); `facts/loops/mutes.rs`. Its counter is `M next_loop_suppressions_id`. Store formats 6 and older kept these rows at `F 0x10`, the take purge ledger's prefix, so every take purge read scanned the mutes; format 7 moved them (see "Sub-tags" below). |

| `F 0x12 kind source_id day` | `RollupRecord` (JSON: the counts, `cost_usd`, `halt_reasons`, `updated_at_us`) | One `extract_rollup_7d` row (primary key `(kind, source_id, day)`, `day` as `YYYY-MM-DD`); `facts/extract_rollup.rs`. |
Sub-tags: each record kind has its own byte after `F`, assigned in the module that writes it. `0x0E`
is retired (the v0.60.766.0 addon's inline generation ledger) and must not be reused; `0x13` is the
next free byte. `crates/gbrain-store/tests/key_registry.rs` scans the store source for every
`(family, sub-tag)` a module declares and fails when two record kinds share one, so a new kind takes
a free byte or the build fails. Format 7 split `F 0x10`: take purges kept it and the loop mutes moved
to `0x11` (the loop mutes were the smaller set to move; a brain's mutes are a handful, its take
purges one record per purged claim). The open-time upgrade is `facts/key_split.rs` (see
[format.md](format.md)).

### Page purge ledger (`facts/page_purges.rs`)

`upsertPagePurges` (the page purge sweep's `tombstonePage`; the store method `record_page_purge` is the same writer with
the arguments spread out) writes one `page_purges` row per content hash, as `purge_page` does in Postgres: a second
write of the same `(source, hash)` replaces the slug and request id and stamps `purged_at` with the transaction clock
(the store clock outside one). A source that does not exist is refused, as the foreign key does in Postgres, a
repeated hash in one call and a `requestId` that is not a UUID are refused with nothing written, an empty hash list
writes nothing, and deleting a source deletes its rows (`ON DELETE CASCADE`). `listRecentPurgeRequests(days, cap)`
answers the distinct non-null request ids of rows purged strictly inside the window, in byte order, up to the cap; the
fact purge ledger (`fact_purges`) and the take purge ledger (`take_purges`) add their ids too.
The page guard (`refuse_purged_page`) refuses a page write that stores a tombstoned content hash in its source with
`purged_content`, as the `pages_refuse_purged` trigger does: `putPage` on every write, other page writes on insert or
when the hash or source changes; a page with no hash (a segmented shell) passes. The restore replay
(`belief/purge-mirror.ts`) still writes the ledger with raw SQL, which a Rust brain refuses.

### Relink attempts (`facts/relink.rs`)

`upsertFactRelinkAttempt` writes one row per `(source, fact)`; a second write replaces every
column and stamps `attempted_at` with the store clock. With `keepModelAndRun`, a conflict keeps
the stored `model` and `run_id` (a first write stores the given ones). The row has no foreign
key, as in Postgres: deleting a fact or its page leaves the attempt in place, and the source
check is the caller's. `listFactRelinkOutcomes` answers in fact-id order. The doctor's unlinked
reads use the attempts as memos: a row is tried when its attempt is `conversation_unresolved`,
unless a page created in the source at or after the attempt (in its clock tick too) re-arms a NULL or re-armed reason
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
`UPDATE` runs, as on every fact write ("The fact purge ledger"), and so does the withdrawal guard
(`withdrawal_guard.rs`, "Captured-facts and rehome repair"): both set `entity_slug`, so a row they
leave active that a withdrawal of its claim reaches on the new entity is saved expired.

`listConversationRelinkPages` is the page pick of `gbrain facts relink --conversation`. It reads
the source's rows in one snapshot and counts, per `source_markdown_slug`, the live rows written by
a conversation extractor (not an audit row), user or unattributed, with no entity (or, with
`unbacked`, on an unbacked name key). With `skipTried` it leaves out a row whose attempt is a
`conversation_unresolved` miss, unless a live page created at or after the attempt re-armed the reason (`rearmedReasons`,
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
reads serve both forms of `hasAttempts`.

| Member | Rust | Missing data when refused |
|---|---|---|
| `listConversationFactRows` | served | |
| `countRedactedFacts` | served | |
| `listOutsideContentFenceCounts` | served | |
| `countAtomFacts` | served | |
| `listUnpreviewedTrustFacts` | served by `facts/trust_reads.rs` | |
| `countUnlinkedFactsByOrigin` | served | |
| `countUnlinkedFactStats` | served | |
| `countFactRelinkOutcomes` | refused | the `fact_relink_attempts` table |
| `listUnlinkedConversationSlugs` | served | |
| `countFactEmbeddingCoverage` | served | |
| `countStaleFactEmbeddings` | served | the same eligibility as `countFactEmbeddingCoverage`; `chars` counts code points |

- With `hasAttempts: false`, the unlinked reads ignore attempt memos: `conversation_tried`, `conversation_paid`,
  `no_subject` and `conversation_unresolved` are 0, and only `relink` targets rows. With `hasAttempts: true`, the native
  reads consult `fact_relink_attempts` and compute those counts and the `relink`, `reextract` and `manual` targets from it.
- `countFactEmbeddingCoverage`, `countStaleFactEmbeddings` and `listOversizedStaleFacts` share one scan
  (`for_each_embeddable_fact`), which skips a withdrawn fact as `retainedFactEmbedding` does: a withdrawal at the
  fact's source and visibility under `gbrain_fact_fingerprint` or `gbrain_fact_fingerprint_v1` of its text, whose
  subject is the fact's page for a fact on `memory/members/...`, else `*` or the fact's entity. Unlike the write-time guard it gives an unbacked name key no extra subjects.
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
| `listFactProvenance` | `{ id, source }` of each listed fact of the source, by id | served |
| `factsOrAliasesMayMatch` | whether a fact slug segment of the source starts with a token, or a page alias of the source is listed | served |
| `listFactsForPage` | the fence-owned rows of a page by row number then id; times come back as `Date`s | served |
| `countLegacyFactsPending` | per entity page, the unexpired unfenced non-observation rows of a live page in a source with a checkout | served (no set order) |
| `countUnconsolidatedFactsBySource` | the consolidate buckets of at least `minPerBucket` active unconsolidated facts | served; "names readers" is a page whose frontmatter has `readable_by` or that sits under a folder rule or a pending prefix (`folder_restricted`); `page_readers` is empty, as in `privacy.rs` |
| `findBulkFactDays` | the bulk days of unarchived sources under a `rule`, with top sources and self-dated claims | served; refused when a count threshold is not an integer or the share is not finite |
| `maxFenceRowNum` | the largest `row_num` of a page coordinate, 0 for none | served |
| `listStoredFenceFactRows` | the numbered rows of a page coordinate, oldest id first | served |
| `countWorldFacts` | the entity card's unexpired fact count under its visibility and privacy | served; a trust floor (`eligibility.floor`) and `suppressFlagged` apply `trust::TrustPolicy` to the fact's stamped tier and its write-gate receipts; `excludePrivate` serves a caller with a reader identity and a private-readable grant (`callerReaders`) and refuses any other caller whose rendering is not the store's policy. Deleted and quarantined pages are always hidden, and `needs_rederive` hides a row a purge marked (`generations/needs_rederive.rs`) |

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
| `listDerivedRows` | One hop of the derivation walk (`derivedRowsFrom`): the rows derived from a frontier of `{ table, id }` inputs. It reads the store's `derivation_inputs` reverse index (["Derivation inputs"](#derivation-inputs-generationsderivation_inputsrs)): distinct, in `(derived_table, derived_id)` byte order, at most `limit`; a NUL in a table or id is `invalid_argument`. |
| `expireFactsByWithdrawal` | The write: stamps `expired_at` now and `valid_until` at the lesser of its value and now on the same rows (by the text's fingerprint) and answers `[{ id }]` in id order. Run it on the engine, outside a transaction. |

`SELECT *` rows (`findActiveSingleFact`) carry the stored `trust_tier` and `write_origin`, and null for
the one column the store has not got: `source_window`. The `write_*` and `last_write_*` columns and
`last_written_at` carry the fact's write receipt (`write_receipt.rs`).

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
locks the row `FOR SHARE` for the rest of the transaction. On Rust the read runs inside the caller's store transaction
and sees its writes; that transaction holds the store's single writer from begin to commit, so no other writer changes
the page before the settle commits. Outside a transaction it reads the last commit. The extract_facts commit step
(lock, then the `complete` settle, in one transaction) runs whole on Rust.
`listSingleFactMetadata` is served by `facts/trust_reads.rs` (below).

## Group 5: repair classifiers and loop retirement (`facts/repair.rs`)

Ten members (`src/core/engine-sql/facts-repair.ts`). Nine are served: four read only `facts` and `pages`, the two loop
reads come from `facts/loops.rs`, `countLabelFacts` reads facts, pages, loops and withdrawals, `countPurgedPageFacts`
also reads the `page_purges` ledger (`facts/page_purges.rs`, key `F 0x0C source \0 content_hash`) and
`listUnwithdrawnFacts` reads the derived generation ledger (`facts/generations.rs`, through `generations.rs`, keys
`h 0x01 id` and `h 0x03 id item_key`). One
reads a table the store does not hold and refuses with `engine_capability_missing` (it is absent from
`store-members/facts-repair.ts`, so the capability named in `members.ts` is `facts`).

The derived generation ledger is the one `generations.rs` keeps and its typed members write (`activateGenerationRows`,
`recordHeldGenerationRow`, which the fence publish's `activateGeneration` and `recordHeld` in `generations/publish.ts`
call), so `listUnwithdrawnFacts` lists the facts a fence generation retired on every arm. The store also keeps no
`version_history_gap_at` (`page-state/versions.ts` sets it with raw SQL), so `history_gap` is always false.

`upsertPagePurges({ sourceId, contentHashes, slug, requestId })` writes `page_purges` (`facts/page_purges.rs`): one
tombstone per hash under the slug; a hash already tombstoned in the source takes the new slug, request id and time
(`ON CONFLICT ... DO UPDATE`). The time is the open transaction's clock. An empty list writes nothing and reads no
source; a repeated hash, a `requestId` that is not a UUID or a NUL character refuses with `invalid_argument`; a missing
source refuses as the foreign key does. The page purge sweep (`persistence/page-purge.ts` `tombstonePage`) writes its
tombstones through it. The restore replay (`belief/purge-mirror.ts`) writes them through `replayPagePurges`
(`engine-sql/belief-purge.ts`), which differs in one way: a hash already tombstoned keeps its `purged_at_us`.
`countPagePurgeTombstones(sourceId, slug)` counts the source's tombstones under the slug. Deleting a source deletes its tombstones. A page write that stores a hash tombstoned in its
source refuses with `purged_content`, as the Postgres `pages_refuse_purged` trigger does: `putPage` always (it is an
upsert, so the `BEFORE INSERT` trigger fires even when the page already holds the hash), every other page write
(`pages::write_page`) on insert or when the hash or source changes.

### The page purge's reads and tombstone edits

Seventeen members (`src/core/engine-sql/page-purge.ts`; `facts/page_purge_reads.rs`, `facts/page_purges.rs`,
`facts/purge_ledger.rs`, `facts/take_purges.rs`). A page's facts are those filed on it (the `F 0x04` page index) and
those extracted from it and filed on none (a page-extraction source whose context head is the slug; the source's facts
are walked, as `countPurgedPageFacts` does). Outcome markers are never claims. Members whose SQL has no order
(`DISTINCT`, `UNION`) answer sorted, as the SQL functions do.

| JS | Resolves |
| --- | --- |
| `listPurgeClaimFacts(sourceId, slug)` | `[{ id, fact, source }]` of the page's first 1000 facts by id, outcome markers included |
| `listPurgeClaimTakes(pageId)` | `[{ id, claim }]` of the page's first 1000 takes by id; an unknown or negative id answers nothing |
| `listPurgeSegmentClaims(sourceId, slug, pageId)` | the text of the page's facts (outcome markers apart) and takes, once each, in byte order |
| `listQueuedPagePurges(sourceId, after, limit)` | `[{ id, slug, page_id }]`: the source's queued `delete_page` requests with `intent.purge` true after sequence `after`, by sequence, up to `limit`, each with the id of the page at its slug (`null` for none). Reads the journal's request records. `after` that is not an integer refuses |
| `listPageLinkStreams(sourceId, pageId)` | the slug of the stream of every link to or from the page (the origin page's slug when the link has one), in byte order, for the streams in `sourceId` |
| `readPurgePageBody(pageId)` | `{ content_hash, body_generation }` of the page; `null` for none. A page with no segmented body state reads generation 0 |
| `listPageMirrorFacts(sourceId, slug)` | `[{ fact_hash, visibility, subject }]`: each distinct claim of the page that is not an outcome marker, `fact_hash` the `gbrain_fact_fingerprint`, `subject` the entity or `*` |
| `listPageMirrorTakeHashes(pageId)` | the fingerprint of each distinct take claim of the page, in byte order |
| `countPageCascadeRows(pageId)` | `{ chunks, versions, takes, timeline }` of the page |
| `listPageVersionSourcePaths(pageId)` | the distinct source paths of the page's versions, up to 64, in byte order |
| `listPageVersionBodiesForPurge(pageId)` | the page's newest 1000 versions, newest first: title, type, both text columns (null for a segmented snapshot), frontmatter, tags, `body_storage`, `body_generation`, and the content hash of a segmented snapshot (an inline snapshot answers `null`, as the SQL engines' inline insert leaves the column null) |
| `insertPageFactPurges(sourceId, slug, requestId, actor)` | writes one `fact_purges` tombstone per distinct (visibility, entity or `*`, fingerprint) of the page's facts, outcome markers apart, reason `page purge`, at the transaction clock; an existing tombstone keeps its columns. A `requestId` that is not a UUID refuses; a page with no claims writes nothing and reads no source |
| `listPagePurgeTombstones(sourceId, limit)` | `[{ content_hash, slug }]` newest first |
| `listPagePurgeRows(sourceId \| null, limit)` | `[{ source_id, slug, content_hash, request_id, purged_at }]` of one source or of every source, newest first |
| `deletePagePurgeTombstones(sourceId, slug)` | removes the slug's tombstones and resolves each one's request id (`null` for none). It takes no row lock: the store admits one write transaction at a time, so the transaction `unpurgePage` opens, which also reads `lockSourceRow`, already serializes its writers |
| `deleteFactPurgesByRequests(sourceId, requestIds)` | removes the source's `fact_purges` rows of those requests; how many |
| `deleteTakePurgesByRequests(sourceId, requestIds)` | removes the source's `take_purges` rows of those requests; how many |

Tombstones list newest first by their purge time, equal times in key order. An id that is not a UUID in `requestIds`
refuses with `invalid_argument`.

### The page purge sweep, its segment storage and its slug stores

Eighteen members: the eleven new ones of `src/core/engine-sql/page-purge-sweep.ts` and seven that `facts-purge.ts` and `purge-slug-stores.ts` already had, now served (store files
`eval_capture/decide_proposals/purge.rs`, `trust/proposals/purge.rs`, `trust/write_gate/purge.rs`, `raw_files/purge.rs`,
`page_body/purge_sweep.rs`, `facts/page_purge_sweep.rs`, `facts/page_purge_journal.rs`, `aliases.rs`, `takes/proposals.rs`,
`facts/loops.rs`). Every delete runs in the caller's purge transaction and removes the row with each key that points at it.
Members whose SQL has no order (`RETURNING`, `UNION`) answer sorted, as the SQL functions do.

| JS | Resolves |
| --- | --- |
| `deletePurgeReviewQueue(sourceId, refs)`, `deletePurgeReviewProposals(sourceId, refs)`, `deletePurgeDecideProposals(sourceId, factIds)` | how many rows of the source name a ref (`a_ref` or `b_ref`, ids as text) or a fact (`new_fact_id`, `old_fact_id`); the fact purge and the page sweep share them |
| `deletePurgedPageTrustProposals(sourceId, pageId, factIds, takeIds)` | how many of the source's trust proposals name the page, a fact or a take as target or related row; each pending key goes only when it points at the proposal |
| `deletePurgedPageHolds(sourceId, slug)` | the ids (text, in id order) of the slug's holds, with their dedupe keys |
| `deletePurgedPageGateReceipts(pageId, factIds, takeIds, holdIds)` | how many receipts name the page, a fact, a take or a hold (ids matched as text) |
| `deletePurgedPageFacts(sourceId, slug)` | how many facts the page has (`page_facts`: filed on it or extracted from it), removed with their indexes; a successor link that named one is cleared |
| `deletePurgedPageFiles(sourceId, slug, pageId)` | the storage paths (sorted) of the files attached to the page and of the detached ones that still name the slug in the source |
| `listPageTimelineReceipts(sourceId, slugs, limit, after, withDiffs)` | the add_timeline_entry (and, with diffs, edit_page) receipts of the slugs after a sequence, by sequence: `id`, principal, `sequence` as text, `summary`, `source`, `bullet`, `diff` |
| `listPageSegmentShas(sourceId, slug, pageId)`, `countPageManifestRows(pageId)` | the sha256 (hex, sorted) of the texts the page's manifest and stagings name; how many manifest rows the page has |
| `deletePageStagings(sourceId, slug, pageId)`, `deletePageSegmentTexts(sourceId, shas)` | how many stagings of the slug or page (with their client keys and recorded texts) and how many unreferenced, unrecorded texts among the shas |
| `sweepPageTextsForClaims(sourceId, cursor, forms, chunkBytes)` | `{ last, deleted }`: one statement of the claim sweep over the source's unreferenced texts after the cursor, 4096 at most, bounded by `chunkBytes` before each text, deleting those whose lowered text holds a form and that no live staging recorded |
| `listPageChangeReasons(sourceId, slug, pageId)`, `listRequestsRecordingReasons(sourceId, slug)` | `[{ reason }]` (NULL first, then byte order); `[{ id, principal_kind, principal_id }]` by sequence, first 10000 |
| `deletePurgedSlugStoreRows(sourceId, slugs)` | `{ removed, secretStore }`: rows scrubbed from take proposals, open loops, page aliases, slug aliases and rename history; a slug named twice counts once |
| `listPageSecretOccurrences(pageIds)` | `[]`, without a store call |

The store keeps no `core_edit_notices` and no secret store, so `deletePurgedSlugStoreRows` answers `core_edit_notices: 0` and
`secretStore: false`, and `scrubPurgedSlugStores` then reports `secret_store_occurrence` and `secret_store` as 0 (it does so
only when the caller did not pass `ifPresent`, which names a restored archive). `listPageSecretOccurrences` has nothing to
read. A text is needed while a manifest row names it or a live staging (a live state, or one an outstanding request names)
recorded it; a text that is not UTF-8 refuses the claim sweep, as `convert_from` does. `sweepPurgedPage` itself still stops on
the Rust engine at the statements of other units that it runs in the same transaction (`clearRebuildableCache`, the intent
redaction, the generation ledger scrub), so `delete_page --purge` is guarded until those are served.

| Member | What it answers | Rust |
| --- | --- | --- |
| `listSessionFactsForClassification` | Active, unsuperseded facts of the capture lanes whose attribution is the user or unset, optionally only the named ids, by (source, id). | Served |
| `listSessionFactTwins` | For each named fact: whether an owner twin exists outside the lanes and the sessions of its lane twins (`twin_sessions`: distinct, `''` for no session, in text order). By id. | Served |
| `listCapturedFactsForClassification` | The same lane facts with their fingerprint and `legit_twin` (another non-expired fact of the source with the same visibility, entity and fingerprint outside the lanes). By (source, id). | Served |
| `listWorldFactsFromPrivateSources` | Active `world` facts held in, or extracted from, a page that is private by `visibility`, a privacy alias or `readable_by`, with `readable`. By id. | Served |
| `loopFactDrift` | Closed loops whose commitment fact is still active. | Served from `facts/loops.rs`: a `done` or `dropped` loop of the named sources whose fact is in its own source with no `expired_at` and no `open` loop references it, by id |
| `closedLoopWithActiveFact` | One closed loop whose commitment fact is still active. | Served from `facts/loops.rs`: a `done` or `dropped` loop whose fact exists with no `expired_at` |
| `countLabelFacts` | The bounded count of evidenced label facts. | Served: the active facts of `segmentSource` whose context holds the `%text%` of `contextLike`, on a live page whose body or timeline has a line that opens with `**`, a label, any `[[:space:]]` and `:**` (ASCII case folding; `[[:space:]]` is the musl `iswspace` set PGLite reads, where Postgres on glibc also counts U+1680), on a page no active `extractor_version=N`-stamped audit fact decided, unsuperseded and no row's successor, named by no loop and covered by no withdrawal. The store counts up to `cap + 1` and the member caps it. `store-members/label-line.ts` reads the label line into its literal labels; any other pattern, a context pattern other than `%text%` and a cap that is not an integer refuse |
| `listLabelFactCandidates` / `listSegmentedLabelPages` / `hasActiveAuditMarker` | The `repair conversation-labels` preview reads: each candidate with its evidence, the segmented census and the decided-page check. | Served from `facts/label_repair.rs`: the label line is read as in `countLabelFacts`; candidates by (source, page bytes, id), sources in byte order. Pinned by `tests/label_repair_reads.rs` |
| `listExtractorFactsForClassification` | Expired fenceless extractor facts with page, withdrawal, duplicate, fence and receipt evidence. | Served from `facts/extractor_classify.rs`: the facts of the sources whose `source` starts with `cli:extract-conversation-facts`, expired, with no `row_num`, a `source_markdown_slug` (of `slug` when set) and no `retired: conversation-labels` in `context`. `page_id` / `page_deleted` name the provenance page, live or soft-deleted; `withdrawn` is a withdrawal of the source at the fact's visibility with either fingerprint under `*` or the fact's entity; `active_duplicate` is an active row of the page with the same visibility, fingerprint and entity; `fence_history` is any row of the page from another source. `receipt` / `receipt_consumer` are the `request_id` and `consumer_version` of the write journal's lowest-sequence `committed` request of the page whose `completed_at` is the fact's `expired_at`; the read writes nothing there. `expired_at` is UTC microsecond text. By source id, page slug, id |
| `listClosedConsolidationTies` | Active typed facts consolidation closed at their own instant, with the facts of their take that state the same claim then. | Served from `facts/repair_previews.rs`: no `expired_at`, a claim metric, an entity, `consolidated_into` set and `valid_until` equal to `valid_from`; `partners` are the other facts of the source in the same take with the same metric, unit and period (`IS NOT DISTINCT FROM`) and `valid_from`, or null for none. `valid_from` is `timestamptz::text` in UTC. By (source, id) |
| `listPagelessEntityFacts` | Every entity slug with no live page: its database-only fact ids and its fenced fact count. | Served: facts with an entity grouped by (source, slug); `ids` are the rows with no `row_num` (null for none), `fenced` counts the rest; a slug whose page row is live is dropped, a soft-deleted page does not count. By (source, slug) in byte order (Postgres orders in the database collation: the same for lowercase slugs) |
| `listOntologyFactCandidates` | Ontology rows with the fence step's signature and their withdrawn, consolidated and duplicate flags. | Served: facts with a dimension, an entity and a `source`, that are not a conversation-extractor slot, with a `row_num` or a `source_markdown_slug` other than `source`. `withdrawn` is the extractor read's rule (either fingerprint, subject `*` or the entity); `duplicate` is another row with the same entity, dimension, value hash, `source_markdown_slug = source` and `valid_from`. `expired_at` is the UTC microsecond text. By id across the sources |
| `listDuplicateFactRows` | Active facts that share a source, visibility, speaker and fingerprint with another such fact. | Served: no `expired_at`, no `superseded_by`, `valid_until` unset or after the store clock's now, `source` not in `excludedSources`; the fenced flag is a `row_num`, a page slug and a `source` that does not start with `cli:`. Groups order by (source, visibility, fingerprint, speaker) in byte order, rows by fenced first, `created_at`, id. The statement's extra `created_at` and `n` columns are not part of the row |
| `listFactsOnValidDay` | The unexpired facts of a source whose `valid_from` falls on a UTC day. | Served from `facts/repair_previews.rs`: no `expired_at` and the UTC date of `valid_from` equal to `day` (a `YYYY-MM-DD` real date: any other spelling refuses, where the SQL's `$2::date` reads more). `valid_from` is `timestamptz::text` in UTC and `valid_until_day` the UTC day of `valid_until`. By id |
| `readLivePageByPath` | The live page of a source recorded at a `source_path` (the lowest id), or null. | Served from `write_guards.rs` through the live-origin index: the live pages of the source whose origin is `path`; an empty path is never an origin, so reads null (the SQL would match an empty `source_path`) |
| `listPurgedPageFactCandidates` | The gone-page facts of the sources (or of `ids`) with the exclusion flags and the purge evidence the `purged-page-facts` classification reads. | Served from `facts/repair.rs`: the filter of `countPurgedPageFacts` with no exclusion applied; `withdrawn`, `superseded`, `referenced` (another fact's `superseded_by` names it), `open_loop` and `purged` (a `page_purges` record of the head at or after `created_at`) are flags. By (source, page head, id) in byte order |
| `listFactsHomeCandidates` | The unexpired facts of a source with no fence position (ontology rows too), with whether the entity has a live and a soft-deleted page. | Served from `facts/repair_home.rs`: by entity (a fact with no entity first), then id; `valid_from` and `valid_until` are ISO text the member turns into dates |
| `listHeldHomeRows` | The unexpired fence rows held on a holding page of the source that name an entity which is not a holding slug, with whether the entity has a live page, the `created_at` second and whether the row is over `days` days old. | Served from `facts/repair_home.rs`: the holding page must have a page row (live or deleted), as the SQL's subquery reads `pages` unfiltered; `days` counts 24-hour days from the store's clock and must be a whole number. By entity, then id |
| `listOrphanedFenceRows` | The unexpired fence rows of a source whose page is not live, with that page's slug. | Served from `facts/repair_home.rs`: by id |
| `readFactSnapshots` | The named facts of a source as the 27-column `jsonb_build_object` snapshot. | Served from `facts/repair_home.rs`: times are the text `jsonb` gives a `timestamptz` (`2026-02-03T10:11:12.345+00:00`); `lock` (FOR UPDATE, a SQL transaction only) refuses on Rust. By id |
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
- A page is also private when it sits under a folder (`folderRestrictedSql`): a folder rule of its source is
  stamped on it, or a pending or invalid prefix of its source covers its slug (`folder_restricted`).
- The privacy helpers (`provenance_slug`, `snapshot_allows`, `alias_private`, `derivation_private`) are
  re-implemented in `repair.rs` rather than shared with `privacy.rs`.

## Group 5: repair, doctor and write-path sites (`facts/repair_sites.rs`)

Twenty-eight members that were raw `executeRaw` statements in nine callers (`src/core/repair/agent-session-facts.ts`,
`captured-facts.ts`, `facts-rehome.ts`, `src/commands/doctor/checks/fence-integrity.ts`, `facts-pages.ts`,
`unlinked-facts.ts`, `src/core/facts/write-single.ts`, `capture-dedup.ts` and `claim-conflicts.ts`). Each runs the
statement its caller ran, with the same text and parameters, in `src/core/engine-sql/facts-repair.ts` (15),
`facts-doctor.ts` (3) and `facts-trust.ts` (10). Every member below is implemented on Rust:
`facts/captured.rs` ("Captured-facts and rehome repair"), `facts/session_takes.rs` ("Agent-session repair"),
`facts/doctor_pages.rs` ("Doctor page reads") and `facts/write_path.rs` ("Write-path, repair and fence-cycle reads")
serve them.

| Member | Reads or writes | What the statement reads or writes |
| --- | --- | --- |
| `listActiveSourceIds`, `listUnarchivedSourceRows` | `sources` | The source ids in byte order; `archived` is false or unset. |
| `readRepairBrainId` | `persistence_brain` | The brain id row, or null (callers fall back to `host`). |
| `listAgentSessionTakeCandidates`, `retireSessionTakes`, `listInactiveTakeIds` | `takes`, `facts` | The `consolidated_into` and `consolidated_at` columns of facts and the take columns `kind`, `holder`, `active`, `resolved_at`, `created_at`. |
| `listSettledSessionFacts`, `reattributeSessionFacts`, `listOtherAttributedFactIds` | `facts` | `attributed_to`, `context`, `superseded_by`, `row_num`; the re-attribution appends its note once and runs in a transaction. |
| `listFenceRewriteRows`, `expireCapturedFacts`, `listExpiredFactIds` | `facts` | `row_num`, `expired_at`, `context`; the expiry puts its context before the fact's own. |
| `listPagelessEntityFacts`, `readEntityRehomeState`, `rehomeEntityFacts`, `listSourceIncarnations` | `facts`, `pages`, `sources` | Live-page lookups by (source, slug), database-only facts keyed by entity, and the source `incarnation` as text. |
| `listActiveSourceIds`, `listUnarchivedSourceIds` (served) | `sources` | The source ids in byte order; `archived` is false or unset. |
| `readRepairBrainId` (served) | `persistence_brain` | The brain id row, or null (callers fall back to `host`). The TypeScript member answers what `readPersistenceBrainId` answers. |
| `listAgentSessionTakeCandidates`, `retireSessionTakes`, `listInactiveTakeIds` (served) | `takes`, `facts` | The `consolidated_into` and `consolidated_at` columns of facts and the take columns `kind`, `holder`, `active`, `resolved_at`, `created_at`. |
| `listSettledSessionFacts`, `reattributeSessionFacts`, `listOtherAttributedFactIds` (served) | `facts` | `attributed_to`, `context`, `superseded_by`, `row_num`; the re-attribution appends its note once and runs in a transaction. |
| `listFenceRewriteRows`, `expireCapturedFacts`, `listExpiredFactIds` (served) | `facts` | `row_num`, `expired_at`, `context`; the expiry puts its context before the fact's own. |
| `listPagelessEntityFacts`, `readEntityRehomeState`, `rehomeEntityFacts`, `listSourceIncarnations` (served) | `facts`, `pages`, `sources` | Live-page lookups by (source, slug), database-only facts keyed by entity, and the source `incarnation` as text. |
| `countSegmentedCensusPages`, `listFactsPageBodies`, `readFactTableCatalog` (served) | `pages`, catalog | `body_storage`, `source_path`, the bounded body prefix, and `to_regclass` of `facts` and `fact_relink_attempts`. |
| `readFactEntitySlugById`, `readSupersessionReplacement`, `linkSupersededFact` (served) | `facts` | Two-fact join for the fence row, same-page test and validity bounds; `superseded_by` link. |
| `listLivePageTitles`, `listPageAliasNames` (served) | `pages`, `page_aliases` | Live titles and normalized aliases; the alias read throws on a brain with no aliases table. |
| `listCaptureDuplicateCandidates`, `computeFactFingerprints` (served) | `facts` | `gbrain_fact_fingerprint`, the member-owned-page exclusion and a numeric scan limit. |
| `listClaimConflictPairs`, `countClaimConflictPairs` (served) | `facts`, `decide_proposals`, `trust_proposals` | Typed claim columns, the as-of bucket, and the proposal tables that exclude a pair already proposed. |

### Captured-facts and rehome repair (`facts/captured.rs`, `facts/withdrawal_guard.rs`)

Eight store methods serve nine members of `engine-sql/facts-repair.ts` (`readRepairBrainId` is the journal's brain id,
`readPersistenceBrainId`). Every method takes one JSON object in `camelCase` and refuses an unknown key.

| Method | Member | Result |
| --- | --- | --- |
| `listActiveSourceIds` | `listActiveSourceIds` | `[{ id }]` of the sources not archived, in byte order. |
| `listSourceIncarnations` `{ sourceIds }` | `listSourceIncarnations` | `[{ id, incarnation }]` of the named sources that exist, archived ones too, by id. The TypeScript member takes `readonly string[]` and binds `[[...sourceIds]]` on SQL. |
| `listFenceRewriteRows` `{ sourceId, ids }` | `listFenceRewriteRows` | `[{ id, fact, row_num }]` of the named unexpired facts of the source, by id; a duplicate or foreign id answers once or never. |
| `expireCapturedFacts` `{ sourceId, ids, context }` | `expireCapturedFacts` | Expires the named unexpired database-only facts (`row_num` null) of the source and answers `[{ id }]`, by id. The context becomes `"{context} \| {existing}"`, or just `context` when the fact has none (an empty existing context counts as none; an empty new context still joins). Written through the fact writer, so the trust stamp and purge guard run. |
| `listExpiredFactIds` `{ sourceId, ids }` | `listExpiredFactIds` | `[{ id }]` of the named facts of the source that are expired, by id. |
| `listPagelessEntityFacts` `{ sourceIds }` | `listPagelessEntityFacts` | Per (source, `entity_slug`) with no live page (a soft-deleted page counts as none): `{ source_id, slug, ids, fenced }`. `ids` are the database-only fact ids in id order, `null` when every fact is fence-held; `fenced` is the count of fence-held facts. By (source, slug) in byte order. |
| `readEntityRehomeState` `{ sourceId, from, to }` | `readEntityRehomeState` | Always one object `{ from_live, to_live, ids }`, `ids` the database-only fact ids keyed under `from`, `null` when none. |
| `rehomeEntityFacts` `{ sourceId, from, to }` | `rehomeEntityFacts` | Moves the database-only facts keyed under `from` to `to` in one write. A stint key a fact already holds on `to` refuses with `constraint_violation` (`idx_facts_ontology_stint_dedup`) and no fact moves; the TypeScript member raises it as Postgres does (see "Unique violations"). Answers null. |

### Doctor page reads (`facts/doctor_pages.rs`)

Three store methods, family `facts_doctor`, serve the page reads of the `gbrain doctor` checks in
`fence-integrity.ts`, `facts-pages.ts` and `unlinked-facts.ts`.

| Method | Result |
| --- | --- |
| `countSegmentedCensusPages` `{ sourceIds, checkedOutSourceIds }` | `{ n }`: the live markdown pages of `sourceIds` stored in segments that the census walked no file for (no `source_path`, or a source outside `checkedOutSourceIds`). An unknown key refuses. |
| `listFactsPageBodies` | `[{ slug, source_id, segmented, body }]` of the live `type: facts` pages, by source id then slug in byte order (`COLLATE "C"`). `body` is the first 65536 code points of the inline body, or of a segmented page's published truth lead; it is null for a segmented page with no published lead. |
| `readFactTableCatalog` | `{ facts: 'facts', attempts: 'fact_relink_attempts' }`. The store always keeps both record families, so `to_regclass` finds both. |

A page is stored in segments when its body state says `segmented` (`page_body.rs`); its truth and timeline are then
null, as `pages_body_storage_chk` requires.

### Agent-session repair (`facts/session_takes.rs`)

Six store methods serve the six `gbrain repair agent-session-facts` members. Each takes one JSON object in `camelCase`
and refuses an unknown key. The store keeps no index of `consolidated_into`: the candidate read scans the facts of the
named sources, and the retirement scans every fact (its `NOT EXISTS` and `min(consolidated_at)` read facts of any
source).

| Method | Member | Result |
| --- | --- | --- |
| `listAgentSessionTakeCandidates` `{ sourceIds, ids, noteMark }` | `listAgentSessionTakeCandidates` | `[{ id, source_id, slug, row_num, claim, fact_ids, user_fact_ids, noted }]`: each active, unresolved `kind: fact` / `holder: self` take on a page of the sources, with the facts of those sources consolidated into it (`ids` null is every take). `user_fact_ids` are the contributors attributed to `user` or unset; `noted` is true when an `other` contributor's context holds `noteMark`. A take created more than one second before its first consolidation is left out. By the page's source, then slug, in byte order (`COLLATE "C"`), then take id. |
| `listSettledSessionFacts` `{ sourceId, ids }` | `listSettledSessionFacts` | `[{ id, context }]` of the named unexpired, unsuperseded facts of the source attributed to `other`, by id. |
| `reattributeSessionFacts` `{ sourceId, facts, separator }` | `reattributeSessionFacts` | Sets each named active, unsuperseded database-only fact of the source attributed to `user` or unset to `other`, and appends its note after `separator` unless the context already holds it (an empty note is always held). Answers the changed `[{ id }]`, by id; a repeated id changes once, with its first note. Written through the fact writer. |
| `retireSessionTakes` `{ sourceId, takeIds }` | `retireSessionTakes` | Sets `active = false` and moves `updated_at` on each named take whose page is in the source, that is still an open self fact take created no more than one second before its first consolidation, and that no `user` or unset fact of any source feeds. Answers the retired `[{ id }]`, by id. Written through the take writer. |
| `listOtherAttributedFactIds` `{ sourceId, ids }` | `listOtherAttributedFactIds` | `[{ id }]` of the named facts of the source attributed to `other`, by id. |
| `listInactiveTakeIds` `{ ids }` | `listInactiveTakeIds` | `[{ id }]` of the named takes that are inactive, by id. |

`withdrawal_guard.rs` is `gbrain_preserve_fact_withdrawal`. It runs on every insert (`write_fact` with no stored
row, the withdrawal half of `gbrain_guard_inserted_facts`) and on the rows these two writes (and the ontology repair
writes) change. A row that is already expired is left alone. Otherwise the earliest withdrawal of the same source and
visibility whose claim fingerprint (current or v1) and subject reach the row expires it and clamps `valid_until` to
the withdrawal time when that is earlier. A row on a `memory/members/` page matches only a withdrawal of its own page
slug; any other row matches subject `*`, its entity, or (when it is unbacked and not an owned memory subject) any
subject. So `insertFact`, `insertFacts` and the ontology inserts run it on every row they insert, after the purge
refusal. Of the updates, every member whose Postgres `UPDATE` sets a watched column (`fact`, `source_id`, `visibility`,
`entity_slug`, `expired_at`) on a row it can leave active applies it before `write_fact`: these repair writes,
`restoreOntologyFact`, `placeRelinkedFact`, `linkConversationFact`, `restoreSupersededFact`, `restoreFactPreimage` and
`migrateFactsToCanonical`. The other update members the store serves set no watched column, or set `expired_at` to a
time, so the trigger has nothing to do there. `test/engine-parity/fact-update-guard.test.ts` and
`rust/crates/gbrain-store/tests/facts_update_guard.rs` pin the five later members.

The six ontology re-key and repair members (`listRekeyLosers` and its four write companions, `listOntologyFactCandidates`,
`restoreOntologyFact`) are `facts/ontology_repair.rs`; `restoreOntologyFact` also applies the withdrawal guard. See
`ontology.md`, "Ontology re-key and repair statements".

## Group 5: the rest of the facts write and recall sites (not yet in Rust)

Thirty-seven members that were raw `executeRaw` statements in seventeen callers (`src/core/facts/absorb-log.ts`, `backstop.ts`,
`embedding-identity.ts`, `slot-tagging.ts`, `subject-infer.ts`, `writeback-settings.ts`, `retire.ts`, `contested-claims.ts`,
`derivation-inputs.ts`, `single-prepare.ts`, `proposal-supersede.ts`, `forget.ts`, `proposal-review.ts`, `fts-index.ts`,
`question-recall.ts`, `src/core/ops/facts.ts` and `src/core/search/fact-relevance.ts`). Seven are in
`src/core/engine-sql/facts-recall.ts` (`readFactsEmbeddingColumn`, `listNearestFacts`, `listSlotRows`, `listPoolUnbackedKeys`,
`listCallOffCueFacts`, `listPoolEntityPairs`, `listFactRowsByIds`) and thirty are in `facts-trust.ts`. Each runs the
statement its caller ran, except `listNearestFacts`, which binds the embedding model, dimensions and vector literal twice
(dimensions once when the column type is declared), so its `$n` numbers differ from the old text. Except `readFactForForget`, `expireFactSuperseded`, `expireFactAtDate` and `readWithdrawalAnchor`
(served by `facts/forget.rs`, below) the fifteen of `facts/remember_reads.rs` and the six of `facts/recall.rs` (both below), none is implemented on Rust
yet: each is named `facts` in `rust-engine/members.ts` and refuses by name with `engine_capability_missing` until the store
serves it.

| Group | Members | What the store would need |
| --- | --- | --- |
| Write gate | `readPendingWriteReceipt`, `lockSourceShared`, `lockAgentWritebackSetting`, `readMemberPageWithdrawal`, `readClaimWithdrawal`, `readFactVisibility`, `readReplacementTarget`, `readPairFactRow`, `readFactActivity`, `readReviewAcceptedMark` | The write-gate receipt, the shared source lock and advisory lock for the writeback setting, member-page withdrawal, the withdrawal a forgotten claim meets, fact visibility and the replacement and pair rows. |
| Expiry and supersession | `expireSupersededFact`, `restoreSupersededFact`, `expireFactSuperseded`, `expireFactAtDate`, `expireDerivedFacts`, `deactivateDerivedTakes`, `softDeleteDerivedPages`, `markNeedsRederive` | `expired_at`, `superseded_by` and the derived-row columns; each update runs in the caller's transaction. |
| Provenance and listing | `listOversizedStaleFacts`, `listLivePersonTitles`, `readLiveFactEntityPage`, `listFactsToRetireFromPage`, `listContestedProposalPairs`, `recordDerivationEdges`, `listDerivedRows`, `readFactForForget`, `readWithdrawalAnchor` | Live-page lookups, the oversized-fact scan cap, derivation edges and the proposal tables. |
| FTS index | `readFactsFtsIndexState`, `swapFactsFtsIndex` | The `facts` full-text index language and its swap. |
| Recall pool | the seven `facts-recall.ts` members | The embedding column, nearest-vector scan, slot rows, unbacked keys, call-off cues, entity pairs and rows by id (all seven are served: `listFactRowsByIds` by `facts/remember_reads.rs`, the other six by `facts/recall.rs`). |

## Group 5: stamped trust reads (`facts/trust_reads.rs`)

Two reads of the `trust_tier` and `write_origin` the store stamps on every fact row. Neither needs a
key range of its own: they read the fact rows and the write-gate holds (`trust/write_gate.rs`).

| Member | Site | Served | Notes |
|---|---|---|---|
| `listSingleFactMetadata` | `facts/purge.ts` | yes | `id = ANY(ids)` within `sourceId`: a repeated id answers once and an id no row has answers nothing. The SQL has no `ORDER BY`; the store answers in id order. With `remoteFloor: true` the member passes the floor policy (`storeFloorPolicy`) and the store drops a row whose provenance page fails it, as `remoteProvenanceFloorSql('facts')` does. The member refuses an id that is not an `int4`. |
| `listUnpreviewedTrustFacts` | doctor `trust-release-unpreviewed` | yes | Unexpired `user_confirmed` facts whose `write_origin` names the `trust_release` channel and has no `fields_previewed`, each joined to the newest released fact hold with the same source, slug, fence row (`payload->>'row_num'` as text, so `"3"` matches row 3) and request id (`IS NOT DISTINCT FROM`). A fact with no such hold drops out. In id order, at most `limit`; every row carries `total`, the count before the limit. The member refuses a limit that is not a non-negative integer. |

## Stored provenance (`facts/provenance.rs`)

The `source` each fact row keeps, read by id. context_pack and delta attach it to each fact they
deliver as `provenance` (`ops/facts.ts` `withProvenance`, a fail-soft read).

| Member | Site | Served | Notes |
|---|---|---|---|
| `listFactProvenance` | `ops/facts.ts` `withProvenance` | yes | `id = ANY(ids)` within `sourceId`: a repeated id answers once and an id no row of the source has answers nothing. The SQL has no `ORDER BY`; the store answers in id order. The member refuses an id that is not a safe integer. |

## Forget reads and expiry (`facts/forget.rs`)

Four of the members above are served: the reads and writes `forgetFactInFence` (`src/core/facts/forget.ts`) and the
proposal review (`facts/proposal-review.ts`) make. The TypeScript members are `rust-engine/store-members/facts-forget.ts`;
the napi family is `families/facts_forget.rs`.

| Member | What the store does |
| --- | --- |
| `readFactForForget(id)` | The fact by id in any source: `id`, `source_id`, `entity_slug`, `row_num`, `source_markdown_slug`, `expired_at` (a `Date` on the TypeScript side) and `visibility`; `null` for an id below 1 or one that names nothing. |
| `expireFactSuperseded(factId, validUntil)` | For an unexpired fact: `valid_until` = the given instant (or a bare date as its midnight UTC), else `GREATEST(valid_from, LEAST(COALESCE(valid_until, now), now))`; `expired_at` = now. A missing or expired fact is left alone. |
| `expireFactAtDate(factId, today)` | For an unexpired fact: `valid_until` = `today` at midnight UTC, `expired_at` = now. |
| `readWithdrawalAnchor(factId, sourceId)` | `{ withdrawn }` for a fact of `sourceId`: true when a ledger row of the source has the fact's visibility, the fact's current or v1 fingerprint, and a subject the withdrawal reaches (`facts/generations.rs` `covers_fact`: a member page's own subject, else `*`, the entity, an unbacked name key or the owned memory page). `null` when the fact is gone or in another source. |

Both writes go through `write_fact`, so the trust stamp and the purge refusal apply as they do for `expireFact`.
The TypeScript members refuse (`engine_capability_missing`) an id that is not a whole number, a `validUntil` that is not an
ISO instant, a bare date or null, and a `today` that is not a real `YYYY-MM-DD` day, instead of guessing at Postgres's
errors. `expireFactAtDate` is reached only on the fence path of a forget (a written source file); the legacy path
expires through the withdrawal ledger.
Parity: `test/engine-parity/forget-members.test.ts` (the members one by one) and `forget-whole.test.ts` (a whole
`forgetFactInFence` and the `forget_fact` operation). `readFactActivity` (the proposal review's candidate read) is served
by `facts/remember_reads.rs`, below.

## Remember reads and supersession writes (`facts/remember_reads.rs`)

Thirteen of the members above are served: the reads and writes a `remember` with `replaces`, a proposal review's accept and
undo, a page retire and a recall by id make (`facts/single-prepare.ts`, `facts/write-single.ts`, `facts/proposal-supersede.ts`,
`facts/proposal-review.ts`, `facts/question-recall.ts`). The TypeScript members are
`rust-engine/store-members/facts-remember.ts`; the napi family is `families/facts_remember.rs`. Facts are read by id
(`read_fact`) and by source (`source_rows`); every write goes through `write_fact`, so the trust stamp and the purge refusal
apply as they do for `expireFact`, and a `superseded_by` that names no fact refuses as `facts_superseded_by_fkey` does.

| Member | What the store does |
| --- | --- |
| `readFactEntitySlugById(id)` | The fact's `entity_slug`; `null` for no entity or no fact. |
| `readSupersessionReplacement(newId, oldId)` | `null` when either fact is gone, else the new fact's `row_num`, `same_page` (the two `source_markdown_slug` values `IS NOT DISTINCT FROM`, so two facts with no page are on one page), the new fact's `valid_from` and the old fact's `valid_from` and `valid_until`. |
| `linkSupersededFact(oldId, newId)` | Sets `superseded_by` on the old fact. An old id that names nothing updates nothing, even when `newId` names no fact; otherwise a `newId` that names no fact refuses with the foreign key. |
| `listFactsToRetireFromPage(sourceId, session, slug, pattern)` | The source's unexpired facts with `source_session = session`, or `context = slug`, or `context LIKE pattern` (`\` escapes), in id order: `id`, `row_num`, `source_markdown_slug`, `entity_slug`. |
| `listFactRowsByIds(sourceIds, ids)` | The whole rows (the `listFactsByEntity` shape, with the embedding) of these ids within these sources, in id order. The SQL has no `ORDER BY`. |
| `readFactVisibility(id, sourceId)` | `{ visibility }` of a fact of the source, else `null`. |
| `readFactActivity(id, sourceId)` | `{ active, text_hash }`: unexpired and not past `valid_until` now, and the md5 of the fact text; `null` for a fact not in the source. |
| `readReviewAcceptedMark(id, sourceId, mark)` | `{ id }` when the source's fact is expired and its context holds `mark` as a substring, else `null`. |
| `readPairFactRow(id, lock)` | One fact in any source, with the columns `id, source_id, entity_slug, visibility, fact, expired_at, valid_from, valid_until, superseded_by, row_num, source_markdown_slug`. `lock` changes nothing: every store write is serialised. |
| `expireSupersededFact({ oldId, sourceId, newId, until })` | For an unexpired fact of the source: `valid_until` = `until`, else `GREATEST(valid_from, LEAST(COALESCE(valid_until, now), now))`; `expired_at` = now; `superseded_by` = `newId`. Answers the row count (1 or 0). |
| `restoreSupersededFact({ oldId, sourceId, expiredAt, validUntil, supersededBy, expectedSupersededBy })` | Puts the three columns back for a fact of the source whose `superseded_by` is `expectedSupersededBy` (`IS NOT DISTINCT FROM`, so null matches null). Answers the row count. |
| `readReplacementTarget({ targetId, sourceId, excludePrivate, ownPage, lock })` | The whole row of the fact in the source with `withdrawn`: a ledger row of the source and visibility under the fact's current or v1 fingerprint that `covers_fact` reaches (a member page's own subject, else `*`, the entity, an unbacked name key or the owned memory page). With `excludePrivate` the remote provenance floor applies (`hidden_by_private_provenance` with `provenanceOnly`), except to a row on `ownPage`; the TypeScript member serves only the floor `storeFloorPolicy` reads and refuses any other caller. |
| `readMemberPageWithdrawal({ sourceId, visibility, fact, entitySlug, page, ... })` | The withdrawal a remote save onto member page `page` meets (GST-2346). Candidates are the ledger rows of the source and visibility under the claim's current or v1 fingerprint with subject `page` (counted as they are), or `*` or the claim's entity, which count only when they withdrew a row the page's member reads: an expired row of the same visibility and current fingerprint that `withdrawal_covers` reaches, on `page` itself or, for a world row, on pages the page's member's policy does not hide (the provenance and entity pages, `page_hidden`). For the brain owner (`owner`) a row of either visibility counts. The most specific subject first, then the newest; `withdrawn_at` as `timestamptz::text`. |
| `readClaimWithdrawal({ sourceId, visibility, fact, entitySlug, ownPage, excludePrivate })` | The withdrawal a save of claim `fact` meets (`factWithdrawnRefusal`). Candidates are the ledger rows of the source and visibility under the claim's current or v1 fingerprint with subject `*`, the claim's entity or `ownPage`. With `excludePrivate` the remote provenance floor applies (`hidden_by_private_provenance` with `provenanceOnly`), except to a row on `ownPage`: a candidate counts only when it reached a row the caller sees or reached no row, and when the claim's reached rows are all hidden the answer is `{ hidden: true, row: null }`. A non-`*` subject first, then the newest; `withdrawn_at` as `timestamptz::text`. |

The TypeScript members refuse (`engine_capability_missing`) an id that is not a whole number and a time that is not an ISO
instant. `readMemberPageWithdrawal` is served for any member that meets no folder rule. For a member that is not the brain
owner the policy is `readPolicyFragment('pp', identity, true, [])`; for the owner it is the owner read rule,
`ownerReadPolicyFragment('pp', identity, [])`, sent as `ownerRead`. `storeMemberReadPolicy` (`private-provenance.ts`)
compares each with its reference rendering, as the other privacy members do. Under `ownerRead` a derived page's origins are
judged by the owner's identity (`gbrain_access_origin_hidden_for`: an origin closes the page only when it names readers and
none is the owner), and the owner-only test is off. The store keeps no folder rule, pending coverage or audience member, so
those parts of the rule pass. A non-empty `satisfied` list, and an owner identity with no member principal (the rule renders
`FALSE`), refuse. A whole `remember` on a brain
with no signing key goes through the persistence consumer, which calls `readReplacementTarget` and `readFactVisibility`
only; `readSupersessionReplacement`, `linkSupersededFact` and `readFactEntitySlugById` run only in the legacy
`writeSingleFact` path, so only the member case exercises them.
Parity: `test/engine-parity/remember-members.test.ts` (the members one by one) and `remember-supersede.test.ts` (a whole
`remember` that replaces a fact, and the refusals of a gone or already replaced target).

## Recall candidate-pool reads (`facts/recall.rs`)

Six of the `facts-recall.ts` members are served: the pool reads a recall, a search that adds facts and a question recall make
(`search/fact-relevance.ts`). The TypeScript members are `rust-engine/store-members/facts-recall.ts`; the napi family is
`families/facts_recall.rs`. Every read admits a row as `listFactsForRelevance` does (`Pool::admits` in `facts/trust.rs`: the
source, the expiry clauses, the audit sources, a quarantined provenance page, the visibility and private-provenance policies,
a soft-deleted page, the trust floor and the filters), so a row the caller cannot read never shapes a result.

| Member | What the store does |
| --- | --- |
| `readFactsEmbeddingColumn()` | `{ type: 'halfvec', dims }` with the configured embedding width (1536 by default). |
| `listNearestFacts({ scope, filters, vector, declared, limit })` | Pool rows holding a vector of the query's model, nearest by cosine first (ties by id), at most `limit`, each with `similarity` (`1 - distance`). When the column does not declare its width (`declared` false) a row of another length is left out; a row of another length than the query's when `declared` is true refuses as `halfvec` does ("different halfvec dimensions"). |
| `listSlotRows(scope, slots)` | Pool rows, expired ones included in the read, that are still active conversation slot rows (unexpired, not superseded, a value hash, `dim_status` active, a conversation source) of the `(source, entity, dimension)` slots, by `valid_from` then id. The rows carry no `similarity`. |
| `listPoolUnbackedKeys(scope, keys, limit)` | The distinct `(source, entity)` pairs of pool rows whose entity is in `keys` and has no live page (none, or soft-deleted), by source then slug, at most `limit`. |
| `listCallOffCueFacts(scope, pairs)` | For each pair, the newest 50 pool rows (by `valid_from`, then id) whose text holds one of 28 retraction or call-off phrases as whole words, case-insensitive (`\m...\M`, so `cancelledX` and `retractor` do not match; `called off-site` does). |
| `listPoolEntityPairs(scope, filters)` | The distinct `(source, entity)` pairs of pool rows that have an entity. |

The TypeScript members refuse (`engine_capability_missing`) a vector-typed column (the store keeps `halfvec`) and any visibility
or private-provenance policy whose text matches none of the supported reference renderings described above. Supported
labelled-only callers, with lineage off or on, and non-owner lineage reads are served by the private-provenance
fact gate (row 32e-b-4). `hnswIterativeScan` only changes the Postgres plan, so the store ignores it.
Parity: `test/engine-parity/recall-members.test.ts` (edges of each member and the pool functions a search and a recall call, whole),
and the same members in `facts-rest-sites.test.ts`.

## Quote and slot-history reads (`facts/quoted.rs`)

Four `facts-recall.ts` members serve the reads that decide how a fact or a page reaches a model (`search/transcript-quote.ts`)
and the bare-name page lookup of a slot-history question (`search/slot-history.ts` `entityKeys`). The TypeScript members are
`rust-engine/store-members/facts-quoted.ts`; the napi family is `families/facts_quoted.rs`.

| Member | What the store does |
| --- | --- |
| `listFactsFromQuotedPages(ids, pageTypes, backstopSessions)` | Of `ids`, the facts taken from a page of one of `pageTypes` in the fact's own source: the page `source_markdown_slug` names, or the page a backstop fact's `source_session` names (the first `(source, prefix)` pair whose source is the fact's and whose prefix starts the session; the slug is the rest). A soft-deleted page counts. Or the page a `derivation_inputs` edge of the fact names (input table `pages`, an id of 1 to 18 digits, leading zeros allowed), in any source, soft-deleted or not, as the SQL joins `pages.id`. Ascending ids. |
| `listFactIdsAtTrustFloor(ids, floor)` | Of `ids`, the facts whose stored tier ranks at or above `floor` (`trustRankSql`: a name that is no tier ranks 0; an empty name, a record from before the store kept the column, is `unknown`). A floor that names no tier is refused. |
| `readPageTypesByIds(ids)` | `{ id, type }` of each page id, soft-deleted pages included; an id with no page is absent. |
| `listReadablePageSlugs(sourceId, slugs, scope, limit)` | Of `slugs` in `sourceId`, the pages `pageReadFilter(.., live = true)` admits under `scope` (the chunk reads' page policy: privacy, trust floor and flag suppression, not soft-deleted, not quarantined, a live source), at most `limit`. The scope's own `sourceId` / `sourceIds` do not narrow the read. The SQL has no `ORDER BY`; the store keeps the asked order. |

The TypeScript member of `listReadablePageSlugs` resolves the privacy policy as the chunk reads do (a caller's readers are
allowed) and ignores `requireSafeChunks`, which `pageReadFilter` does not read.
Parity: `test/engine-parity/facts-quoted.test.ts`.

## Write-path, repair and fence-cycle reads (`facts/write_path.rs`)

The W2c members of `facts-trust.ts`, `facts-repair.ts` and `facts-cycle.ts` that the capture, embedding backfill and
fence reconcile paths call. The TypeScript members are `rust-engine/store-members/facts-write-path.ts`; the napi family
is `families/facts_write_path.rs`.

| Member | What the store does |
| --- | --- |
| `listLivePageTitles(sourceId, slugs)` | `{ slug, title }` of each live (not soft-deleted) page at the slugs, by slug. |
| `listLivePersonTitles(sourceId, slugs)` | The `listLivePageTitles` rows whose page is `type = 'person'` and not retired (`retiredPageSql`). |
| `listPageAliasNames(sourceId, slugs)` | `{ slug, alias_norm }` of each alias row at the slugs, by slug then alias; a deleted page's aliases too. |
| `listCaptureDuplicateCandidates(opts)` | The facts of the source in `visibilities` with the candidate's fingerprint, unexpired, inside `valid_until`, spoken by nobody else, not `replacingPage`'s conversation-extractor rows and not on an owned memory page; newest first (`created_at`, then id), at most `scanLimit` (a negative limit is refused). |
| `computeFactFingerprints(texts)` | `gbrain_fact_fingerprint` of each text, in order. |
| `listOversizedStaleFacts(opts)` | The stale embeddable facts (the scan of `countStaleFactEmbeddings`) longer than `maxTokens` bytes, by id, at most 10000; `id` as text. |
| `listFenceRowClaims(sourceId, slug)` | `{ row_num, fact, source }` of the page's facts that hold a fence row, by id. |
| `adoptFactIntoFence(sourceId, id, rowNum, slug, fact)` | In one store write, an unfenced fact of the source gets the row number, page and claim text; the withdrawal guard (`preserve_withdrawal`) runs before `write_fact`. A fenced row or another source's row is left alone; an id that is not an integer is refused as `bigint` input. |
| `readSourceCheckoutPath(sourceId)` | The source's `local_path`, null for none or an unknown source. |
| `listPageStates(sourceId, slug)` | The page row (no `deleted_at` filter), then its 20 newest versions that hold a body, newest first; none for a missing page. |
| `countSegmentedVersionsOfPage(sourceId, slug)` | The page's versions with `body_storage = 'segmented'`; 0 for a missing page. |

`readPendingWriteReceipt` reads the persistence request store (`readWriteRequest`) and answers only a queued, running
or recovering request. `lockSourceShared` resolves at once: the store's writer gate already serializes every write.
`readFactsFtsIndexState` and `swapFactsFtsIndex` stay refused: they read and rebuild a Postgres catalog index
(`pg_index`, `pg_get_indexdef`), which a store brain does not have.
Parity: `test/engine-parity/facts-rest-sites.test.ts`, `facts-repair-sites.test.ts` and `facts-cycle-sites.test.ts`;
crate tests: `rust/crates/gbrain-store/tests/facts_write_path.rs`.

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

## Slot-history reads (`facts/quoted.rs`)

`listReadablePageSlugs` serves the bare-name page lookup of a slot-history question (`search/slot-history.ts`
`entityKeys`). The TypeScript member is `rust-engine/store-members/facts-quoted.ts`; the napi family is
`families/facts_quoted.rs`. The quote reads of `search/transcript-quote.ts` are `facts/quote.rs` (see Group 5).

| Member | What the store does |
| --- | --- |
| `listReadablePageSlugs(sourceId, slugs, scope, limit)` | Of `slugs` in `sourceId`, the pages `pageReadFilter(.., live = true)` admits under `scope` (the chunk reads' page policy: privacy, trust floor and flag suppression, not soft-deleted, not quarantined, a live source), at most `limit`. The scope's own `sourceId` / `sourceIds` do not narrow the read, and `requireSafeChunks` is not read. The SQL has no `ORDER BY`; the store keeps the asked order. |

The TypeScript member resolves the privacy policy as the chunk reads do (a caller's readers are allowed) and ignores
`requireSafeChunks`, which `pageReadFilter` does not read. Parity: `test/engine-parity/facts-quoted.test.ts`.


## Group 5: search relevance and trust reads (`facts/trust.rs`)

| Member | Site | Served | Notes |
|---|---|---|---|
| `listFactsForRelevance` | `search/fact-relevance.ts` | keyword and entity arms | The pool predicate and `similarity` are below. `entity_ended` refuses (it reads `fact_withdrawals` and `gbrain_fact_fingerprint`). |
| `countUncomparableFacts` | `search/fact-relevance.ts` | yes | Per source, the most first, then by source id. |
| `listSlotRows` | `search/slot-ends.ts` (`readSlotRows`) | yes (`facts/recall.rs`) | The pool rows, expired ones included in the read, that are still active conversation slot rows (unexpired, not superseded, a value hash, `dim_status` active, a conversation source) of the `(source, entity, dimension)` slots, by `valid_from` then id; no `similarity`. The other five recall pool reads of `engine-sql/facts-recall.ts` are served on rust-5a, not here. |
| `matchSavedFacts` | `search/saved-facts-match.ts` | yes (`facts/saved_match.rs`) | The match columns, `need`, the cue flag, `trust_rank` and `pool_rank`, as below. The member refuses another correction cue, a non-`english` FTS language and a `worldOnly` read a private-facts grant widens. |
| `readEntityNewestFacts` | `search/entity-facts.ts` | yes (`facts/saved_match.rs`) | The saved-fact columns plus the collapse columns, newest first (a fact dated after now ranks by `created_at`, as the SQL's `CASE WHEN valid_from > now() THEN created_at ELSE valid_from END`), then the highest id, 50 rows at most. The member refuses a `worldOnly` read a private-facts grant widens, and the caller rethrows that refusal instead of reading it as no facts. |
| `matchHeadStems` | `search/saved-facts-match.ts` | yes (`facts/saved_match.rs`) | One row per name head, in input order, with the 1-based indexes of the terms its `to_tsvector` matches by `plainto_tsquery`; a stopword term matches nothing. The member refuses a non-`english` FTS language, and the caller rethrows that refusal instead of reading it as no match. |
| `readFactForOwnerAction` | `trust/owner-actions.ts` | yes | Served by `facts/trust_owner.rs`: the 16 bound columns in the SELECT's order, the stored tier, null for no fact. |
| `listStandingPreferences` | `trust/review.ts` | yes | Served by `facts/trust_owner.rs`: the `standing_instruction` flag receipts and the source's claim state, with the owner floor and connector kinds the member passes. |
| `listLexicalContestCandidates` | `trust/supersede-handlers.ts` | yes (`facts/contest.rs`) | Active rows of the entity, kind and visibility whose stamped tier ranks above the writer's (a writer that names no tier ranks 0), on `pageSlug` or, without one, on no owned memory page. Highest id first, at most 200; each row is `{ id, fact, trust_tier }`. |
| `listFactsFromQuotedPages` | `search/transcript-quote.ts` | yes (`facts/quote.rs`) | The ids whose holding page, or the page a backstop fact's `source_session` names, has a type in `pageTypes`; a soft-deleted page counts. A fact whose recorded input page (`derivation_inputs`, an input id of digits) has such a type counts too. Ascending, each id once. |
| `listOwnerTierFacts` | `search/transcript-quote.ts` | yes (`facts/quote.rs`) | The ids whose stamped tier ranks at or above `floor`; a floor that names no tier answers nothing. Ascending, each id once. |
| `listRestatedPrivateCopies` | `trust/supersede-handlers.ts` | yes | Served by `facts/trust_reads.rs`: the stored tier's rank against the writer's, the lowest id; any active world copy on the entity lifts it. |
| `countDerivedFactTaint` | `trust/taint.ts` | yes | Served by `facts/trust_owner.rs`: `write_origin ? 'taint_inputs'` over every source. |

The pool predicate (`poolWhere`), clause by clause: the source list; unless `includeExpired`, `expired_at`
and `superseded_by` NULL and `valid_until` NULL or in the future; no audit checkpoint source; the row's
provenance page carries no `quarantine` key (a soft-deleted page still counts, as the SQL does not read
`deleted_at`); `worldOnly`, widened as in [Visibility widening](#visibility-widening-factswidenrs); the private-provenance policy under `excludePrivate`; a soft-deleted entity or
provenance page hides the row; then the entity, session, `since` (on `valid_from`) and `grep` filters.

- A `minTrust` floor and `suppressFlagged` apply `trust::TrustPolicy` to the fact's stamped tier and its
  write-gate receipts, as the SQL's trust floor and suppression clauses do. The `needs_rederive` anti-join hides a row a purge marked (`generations/needs_rederive.rs`).
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

The `open_loops` table, for the four engine members (`upsertOpenLoop`, `closeOpenLoop`, `listOpenLoops` and the
entity card read `readEntityOpenLoops`, a TypeScript shim over the list read) and the
`loops_close` retry read `closedLoopWithActiveFact`, the retirement scan `loopFactDrift` (doctor
`loop_facts_drift`, `gbrain repair loop-facts`) and the retirement's own read and expiry
(`readLoopFactState`, `expireSourceFactNow`, `rust/docs/store/repair-bookkeeping.md`). Mutes and the
thread verdict are in `facts/loops/mutes.rs` (below). The staleness pass and the sender list still run
through `executeRaw`, so they refuse on this engine.

| Member | What it does |
|---|---|
| `upsertOpenLoop` | Inserts a loop, or updates the row with the same `(source_id, dedup_key)`. The update runs only when the row is open, the new activity is newer, or `closed_by` is `mute_recheck`; and only when `closed_by` is not `muted` or the counterparty email changed. It keeps `thread_id` and `detector`, keeps the old slug, email, page, due time and fact id when the new one is NULL, and keeps the old counterparty source when the new slug is NULL. An open row keeps its earlier `opened_at`; a reopened row takes the new one. Returns `{ id, created, applied }`. |
| `listOpenLoops` | The rows that pass the source list, status, type, counterparty (slug in the counterparty source, or email) and id filters, by `last_activity_at` descending, then id descending, at most the clamped limit. |
| `readEntityOpenLoops` | The shim's entity-card read over `listOpenLoops`: status `open`, the card's slug in its source, slug matches only (an email equal to the slug drops), first `limit` rows in `listOpenLoops` order (newest activity, then newest id), the order the SQL sorts in. |
| `closeOpenLoop` | Closes an open row (in the named source when one is given) with a status, `closed_by` and now. NULL when no open row matches. |
| `closedLoopWithActiveFact` | `{ id, status, fact_id }` of a `done` or `dropped` row (in the named source when one is given) whose fact exists with no `expired_at`; NULL otherwise, also for a row with no fact. |
| `loopFactDrift` | `{ loop_id, source_id, fact_id, status, slug }` of each `done` or `dropped` row of the named sources (only `loopId` when given) whose fact is in the row's own source, has no `expired_at`, and no `open` row references; `slug` is the fact's `source_markdown_slug`. By id. |
| `readLoopFactState` | `{ loop, fact, shared }` for `retireLoopFact` and `gbrain repair loop-facts`: the row (`{ id, source_id, status, fact_id }`, NULL when no row has the id), its fact (`{ id, source_id, expired_at, row_num, source_markdown_slug, fact }`, NULL when the row has none or the fact is gone; `expired_at` as ISO text) and whether another `open` row references the fact. The SQL engines take the rows `FOR UPDATE` when asked; the store serializes its writes, so the member ignores the lock. |
| `expireSourceFactNow` | Expires one fact of the named source that has no `expired_at`: `expired_at` now and `valid_until` the earlier of its value and now (now when NULL), through the fact write path. True when that row changed; false for a missing fact, another source or an expired fact. |

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

### Mutes and the thread verdict (`facts/loops/mutes.rs`)

The `loop_suppressions` table and the open-loop statements `gbrain loops mute`, `gbrain loops unmute`
and the Gmail thread verdict run (`engine-sql/loop-mutes.ts`). loops-store.ts lower-cases each mute
value before it reaches a member.

| Member | What it does |
|---|---|
| `addLoopSuppression` | Writes the `(source, kind, value)` row; a row that exists stays as it is. `kind` other than `sender` or `thread` refuses `constraint_violation`; an unknown source refuses `source_not_found`. |
| `removeLoopSuppression` | Deletes that row; the number deleted (0 or 1). |
| `listLoopSuppressions` | `{ kind, value }` of each mute of the source, by kind, then value. The SQL read has no order; loops-store.ts puts them in sets. |
| `listMuteRecheckThreads` | `{ thread_id, page_slug }` for each thread with a row whose `closed_by` is `mute_recheck`, with the greatest page slug of its rows (byte order). By thread id. |
| `closeMutedLoops` | The ids of the `unanswered_inbound` rows the mute covers that are open or `mute_recheck`; with `apply`, closes them as `dropped` by `muted`. Ascending. |
| `requeueMutedLoops` | `{ id, thread_id }` of the `muted` rows the mute covers that no other mute of the source covers; with `apply`, sets `closed_by` to `mute_recheck`, or to `unmuted` for a row with no thread. By id. |
| `closeThreadLoops` | Closes the `deterministic_thread` rows of the thread that are open or `mute_recheck` (only the `only` loop types when given) as `done` by `closedBy`, now; the number closed. |
| `settleMuteRecheck` | Sets `closed_by` to `unmuted` on the thread's `mute_recheck` rows; the number settled. |

- A sender mute matches `counterparty_email` byte for byte. A thread mute matches the row's
  `thread_id` lowered one code point at a time, as Postgres `lower()` does (`pg_lower_char`), then
  compared byte for byte. Thread ids match the thread byte for byte.
- Every add takes an id from the counter, also one that lands on an existing row, as `nextval` does
  before `ON CONFLICT`. A refused add takes none.
- `apply: false` reads only. `apply: true` reads and writes in one transaction.
- Deleting a source removes its mutes (`ON DELETE CASCADE`).

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

`read_fact_preimages` (`engine-sql/facts.ts` `readFactPreimages`, for `generations/adapters/fact-rows.ts`
`factPreimages`) is the same before-state for named fact ids of one source, each id once, in id order,
expired rows included. An id of another source, or no row, is left out. The member refuses an id that
is not a whole number before it reads, on every engine.

`restore_fact_preimage` (`engine-sql/facts.ts` `restoreFactPreimage`, for `restoreFactRow`) writes such a
before-state back: `expired_at`, `valid_until`, `superseded_by`, `consolidated_at` and `consolidated_into`, and
`row_num` only when no other row of the page holds that number. It changes only the row of that id and source
whose claim and visibility still match, and returns whether it did. Every argument is checked first, as Postgres
casts the parameters before it reads a row, and a `superseded_by` that names no fact is the
`facts_superseded_by_fkey` refusal.

`list_fact_ids_by_source_prefix` (`engine-sql/facts.ts` `listFactIdsBySourcePrefix`, for
`generations/adapters/extracted-facts.ts` `storedRows`) lists the ids of one page's fact rows whose `source`
starts with a prefix, in id order, expired rows included (`COALESCE(source,'') LIKE prefix || '%'`). The
member refuses a prefix that holds `%`, `_` or `\` on every engine, so the match is a plain prefix.
`expire_fact_rows` (`expireFactRows`, for `retireItems`) sets `expired_at` to now on each still-live row of
the named ids in that source; another source's row, a struck row and a missing id are left as they are.

What PGLite reads from the transaction, the store takes as a `FenceContext`: the writer's tier
(`gbrain.write_trust_tier`, undeclared reads as `unknown`, a name that is no tier ranks 0) and the
opened ids (`gbrain.write_open_facts`). Both napi members take it from the store's write trust context
(`Store::fence_context`, [write_trust.md](write_trust.md)), which the direct `applyWriteTrust` call sets. Once the transactions
family lands (a later landing), the engine's transaction will set it; in this landing the engine serves no transaction.
`above` compares the row's stored tier with the writer's. A row is held when it is not `world`, a
cell at its number with its fact asks for `world`, and a `confirm` or `supersede_fact` proposal
names it as the related fact, is `pending`, `rejected` or `undone`, and has a `visibility` key in its
before state (`trust::proposals::held_narrower`, [trust.md](trust.md#trust-proposals-trustproposals)).

## Unique violations

The store refuses a fact write that would duplicate `idx_facts_ontology_stint_dedup` or `idx_facts_fence_key` with
`constraint_violation` and the Postgres message (`duplicate key value violates unique constraint "<index>"`), and rolls
the write back. `mapStoreError` (`src/core/rust-engine/store-errors.ts`) turns that refusal into the error Postgres and PGLite
raise: SQLSTATE `23505` in `code`, the same message, and `schema_name` `public`, `table_name` `facts` and `constraint_name`.
The CLI text, the `--json` envelope and the MCP error are the same as on the other engines (pinned by
`test/rust-engine-store-errors.test.ts`; the parity cases are in `test/engine-parity/facts-unique-violation.test.ts`, which
reaches `rehomeEntityFacts` and `placeRelinkedFact`). Not reproduced: the Postgres `detail` line (`Key (...)=(...)
already exists.`), which the store does not carry; no CLI, `--json` or MCP output prints it. Other unique indexes stay
`constraint_violation`.

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
admitted by the member or grant admission, a copy only the grant admits counting only when its own proposals pass the
same test (the hold chain, `widen.rs` `hold_refused` over `trust::proposals::visibility_proposal_targets`). With no grant, a grant
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
(facts/purge.ts) writes its main tombstone through `insertFactPurge`; the holding-slug tombstones, its take tombstone
(`insertTakePurge`, served: see "The take purge ledger") and the rest of the purge are typed members too; the writes
are served (see "The purge's writes"), but other members the purge reaches are still refused, so a full `purge_fact`
does not run on Rust yet. The plan, dry run and `--match`
reads are typed members: [purge-plan.md](purge-plan.md).

Readers: the fence overlay's `purged`; `isFactPurged` (`is_fact_purged`: point reads for subject `*` and the entity)
and the purge half of `isFactWithdrawn` ([trust.md](trust.md)), which every fact writer runs before it saves;
`completeWriteRow`'s `purge_has_facts` (any tombstone of the source; `purge_has_pages` is hardcoded false, though the store keeps
a native page-purge ledger); `readLedgerSource`'s `purgesPossible` (`brain.hasFactPurges`); and `readSourcePurgeFlags`'s `facts`
(`trust/withdrawals.rs` `read_source_purge_flags`, the import overlay's per-source probe). The source's purge epoch is stored and `advanceSourcePurgeEpoch` increments it.

The guard: every fact write (`write_fact`) refuses with `purged_content` (`purged_content: this claim was purged
from this source and cannot be saved again`, the triggers' message) when a tombstone of the row's source and
visibility names its fingerprint under subject `*`, the row's entity, or any subject when the entity is an unbacked
name key. On insert it skips an extraction outcome marker (`gbrain_guard_inserted_facts`), and an insert it lets
through then gets the withdrawal stamp (`facts/withdrawal_guard.rs`, "Captured-facts and rehome repair"); on update it runs when
`fact`, `source_id`, `visibility` or `entity_slug` changed (`gbrain_refuse_purged_fact`). Postgres fires the update
trigger when the statement sets one of those columns, even to the same value; the store fires it only on a change,
which refuses nothing a no-op update would not already have kept. The refusal rolls back the whole write, as the
trigger's exception does. Deleting a source removes its tombstones.

## The purge's writes (`facts/purge_writes.rs`)

The writes `submitPurgeFactMutation` and `rewritePageBodies` (facts/purge.ts) run in the purge's transaction, each one
store write that answers what the SQL member answers:

- `deletePurgedTakes(takeIds)`: the takes with those ids, with their evidence and embeddings; how many.
- `deletePurgeReviewQueue(sourceId, refs)` and `deletePurgeReviewProposals(sourceId, refs)`: the source's review-queue
  rows and review proposals whose `a_ref` or `b_ref` is a ref, with the proposals' unique-key entries; how many.
- `deletePurgeDecideProposals(sourceId, factIds)`: the source's supersede proposals whose new or old fact is an id,
  with their sweep-slot and claim-pair entries; how many.
- `deletePurgeTrustProposals(sourceId, factIds, takeIds)`: the source's trust proposals whose target or related row is
  one of the facts (`facts`) or takes (`takes`), with their pending and row-index entries; how many.
- `deletePurgeOpenLoops(sourceId, factIds)`: the source's open loops on one of the facts, with their dedup entries.
- `deletePurgeWriteGateHolds(sourceId, factHash)`: the source's holds whose `COALESCE(payload->>'fact',
  payload->>'claim', '')` has the fingerprint, with their dedupe entries; the ids as text, in id order.
- `deletePurgeWriteGateReceipts(factIds, takeIds, holdIds)`: the receipts on one of the facts, takes or holds (ids as
  text); how many.
- `deletePurgedFacts(factIds, sourceId)`: the source's facts with those ids, clearing `superseded_by` on the rows that
  named them; how many.
- `deletePurgedChunks(pageIds)`: the chunks of those pages, clearing the text seal of each page that had any; how many
  chunk rows.
- `listPagesForPurgeRewrite(sourceId, pageIds)`: the source's pages with those ids, deleted or not, each as `getPage`
  gives it with `body_storage` and its tags in byte order as `purge_tags`, in slug order (byte order).
- `updatePageBodyForPurge(sourceId, pageId, compiled, timeline, hash)`: an inline page's body and content hash, the text
  seal and embedding signature cleared; a changed body takes a new knowledge revision, as the revision trigger does.

`blankPurgeCoreEditNotices` answers 0 in TypeScript: the store keeps no core edit notices (the core guard writes them
through `executeRaw`, which this engine refuses). `rewritePageBodies` versions an inline page through `createVersion`
with the preimage it read, which the Rust `createVersion` serves (the store versions the read revision and metadata,
[pages.md](pages.md)); its saved-version read is `listPurgeVersionBodies`.
`deletePurgeTakeProposals` and the segmented-storage writes (`abortPurgedStagings`, `deletePurgedStagingParts`,
`deletePageViewDigests`, `deleteUnreferencedPurgedTexts`) stay refused.

## The take purge ledger

`facts/take_purges.rs` keeps `take_purges` (key `F 0x10 source subject claim_hash`, the row after `F 0x0F`).
`insertTakePurge` is the one writer of the ledger, in two forms. `insertTakePurge({ sourceId, subject, claimHash,
requestId })` stores a tombstone and answers true, or false when the key exists (`ON CONFLICT DO NOTHING`; the stored
row keeps its columns). `insertTakePurge({ sourceId, subject, pageId, requestId })` stores one tombstone under `subject`
for the fingerprint of each distinct take claim of the page (`INSERT ... SELECT DISTINCT gbrain_fact_fingerprint(claim)
FROM takes WHERE page_id = $3`) and answers true when any was new; a page with no takes, an unknown page or a negative
id stores nothing and answers false. A `requestId` that is not a UUID or a NUL character refuses with
`invalid_argument`; a missing source refuses as the foreign key does. `purge_fact` (claim form), the page purge's
`tombstonePage` (`persistence/page-purge.ts`, page form) and the belief purge mirror's restore replay
(`belief/purge-mirror.ts`, claim form, one call per replayed hash) all write through this member. The store keeps the
two forms apart by their field sets (`TakePurgeRow`); a row naming both a claim hash and a page id, or neither, refuses
with an argument error.

Readers: `readSourcePurgeFlags`'s `takes` (any tombstone of the source, read in the same snapshot as `facts`), the
import overlay's take match (`listPurgedTakeRows`, [trust.md](trust.md): the incoming takes-fence rows a tombstone names
for subject `*` or the page, any subject when none is given) and the belief ledger's tombstone read (`tombstoned_hashes`: the hashes among the asked ones that a tombstone of the source
names, under any subject).

The guard (`refuse_purged_take`, the `takes_refuse_purged` trigger's `gbrain_refuse_purged_take`): the page the row's
`page_id` names gives the source and the subject; a tombstone of that source under subject `*` or the page's slug
that names the claim's fingerprint refuses with `purged_content` (`purged_content: this take claim was purged from this
source and cannot be saved again`). A missing page, or a null page id or claim, refuses nothing. The trigger runs
`BEFORE INSERT`, so `addTakesBatch` checks every proposed row, an unchanged upsert row too, before its NOT NULL, CHECK
and conflict checks; `supersedeTake` checks the new row. `updateTake` sets no claim and page id and is not checked.
The refusal rolls back the whole write. Deleting a source removes its take tombstones.

## Conversation fact publication and relink (`src/core/engine-sql/facts-conversation.ts`)

Thirty members, the statements `facts/conversation-publication.ts`, `relink-publish.ts`, `conversation-memo.ts`,
`conversation-relink.ts`, `conversation-entity-hints.ts`, `conversation-incremental.ts`,
`conversation-relink-carry.ts` and `relink.ts` ran as raw SQL. The Rust engine serves all thirty
(`test/engine-parity/facts-conversation-sites.test.ts` is the parity arm): writes and page counts in
`facts/conversation.rs`, reads in `facts/conversation_reads.rs`, the TypeScript side in
`rust-engine/store-members/facts-conversation.ts`. A conversation row is a fact whose `source` starts with
`cli:extract-conversation-facts`; an audit (outcome-marker) row is set aside wherever the SQL sets it aside.

| Members | How the store answers |
| --- | --- |
| `readNewestConversationFactId`, `maxConversationRowNum`, `countActiveConversationFacts`, `countPageConversationFacts`, `countConversationWindowFacts`, `countConversationFactsOutsideWindows`, `listHeldFactSlots`, `readConversationSlotValueHash` | The page's fact rows by (source, `source_markdown_slug`). A window key is `source_window->>'start'`, `'end'` and `'hash'` joined by `:`; a missing part or a window that is not an object gives no key, so the SQL's three-valued `IN` holds (an unanchored row is outside no list of keys and inside none). `valid_from` crosses as ISO text; the TypeScript side makes it a `Date`. |
| `stampConversationSourceWindows`, `moveConversationSourceWindows` | `source_window` is a fact record field, stored as JSON in key order (`jsonb_order`); a record with no window omits the field, so earlier records stay byte-identical. A move reads every row's key before it writes any row, as one `UPDATE ... FROM (VALUES ...)` does, so a chain of moves applies at once. |
| `deleteConversationOutcomeRows`, `clearConversationPageFacts` | One store write. The clear runs the SQL's five steps in order with one `now`: delete spent relinked rows, unslot expired rows, expire relinked rows, expire rows an open loop or another fact's `superseded_by` references, delete the rest. Each step picks its rows before it writes; rows a repair retired stay expired. It returns the sum of the expired and deleted counts. |
| `listPurgeTombstoneMatches` | The fact purge ledger (`purge_hash_under`), with the unbacked-entity rule: an entity with no `/` that names no live page matches a tombstone under any subject. An outcome marker from no source or an audit source is excluded, as the SQL's `NOT (NULL AND true)` is. |
| `findSpentConversationRequest`, `listConversationBatchRequests`, `readStoredConversationEntry`, `readPrincipalCounters` | The write journal records the store keeps under `keys::REQUEST` and the principal counters (`persistence::read_counter`). Batch requests sort by sequence, and a compacted request is left out. |
| `countConversationPagesToExtract`, `listMergedEntityAliases`, `listEntityHintPages` | The source's live pages by type, the slug alias records, and hint pages with `retired` and `folder_restricted`. |
| `findSameClaimFenceRow`, `findOntologyTwin`, `readRelinkSource`, `readReextractOutcomeRow` | Fence rows (`row_num`), the twin with the same (dimension, `value_hash`) preferring an active row, the source record, and the newest active terminal outcome row with the live page's content hash. |
| `listUnbackedConversationRows`, `listUnlinkedConversationRows`, `listClearedRelinkedFacts`, `countEmbeddedFactsAmong` | Derived rows by page slug in byte order then id; cleared relinked rows newest first; distinct ids that carry an embedding. |
| `lockPageById`, `factRelinkAttemptsTableExists` | No store call. A store write runs alone, so there is no row lock to take; the store always keeps the relink attempts records, so the table exists. |

Two parity cases stop on Rust because their fixtures write through `executeRaw` (a compacted request; a restricted
folder), not because a member refuses.

## Facts cycle, phantom redirect and fence-guard statements (`engine-sql/facts-cycle.ts`, item 4.2)

Thirty-four members replace the 37 `executeRaw` sites of eight files. Each runs the statement its caller ran at base
`5e22f0c134`, with the same text and parameters (`test/facts-cycle-sites-sql-pin.test.ts` pins both). The Rust engine serves
all 34 (`test/engine-parity/facts-cycle-sites.test.ts` is the parity arm): `facts/cycle.rs`, `facts/cycle_fence.rs`,
`facts/held_moves.rs`, `facts/write_path.rs` and, for the phantom redirect, `facts/phantom.rs` and `links/phantom_merge.rs`
("Phantom redirect" below). Three members serve two callers each, so 37 sites are 34 members. What each reads, by caller:

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
- `readPageFileOrigin(sourceId, slug, { includeDeleted })` (`databaseOnlyPlacement`, `heldUnmovable` in `facts-home.ts`, and
  `resolvePageWriteTarget` in `write-through.ts`): `source_path` and `source_uri` of the page, or none. A soft-deleted page
  answers only with `includeDeleted`. Served from the page record (`facts/cycle.rs` `read_page_file_origin`).
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

The three members above run on Rust (`facts/held_moves.rs`, the family `facts_held`). `days` must be a plain signed
decimal (at most 6 digits whole and 6 fractional, a day being 24 hours); any other text (`'1 hour'`, `'1e2'`) is
refused with `engine_capability_missing`, where PGLite and Postgres accept any interval. Rows come back in byte order
of the keys, not the collation order a Postgres brain uses.

`facts/fence-write.ts`
- `readFenceRowNumHint(sourceId, slug)` (`writeFactsToFence`): the largest `row_num` of the coordinate, 0 for none. The caller keeps
  its `try`/`catch` around it.
- `readSourceCheckoutPath(sourceId)` (`lookupSourceLocalPath`): `sources.local_path`, none for an unknown source.

`facts/file-body-guard.ts`
- `readLiveStoredBody(sourceId, slug, lock)` (`readStoredBody`): the live page's `compiled_truth` and `timeline`; `lock` is the row
  lock the engine's transaction holds. A segmented page reads null columns. Served from the page record (`facts/cycle.rs`
  `read_live_stored_body`); the store's writer gate, held by a `transaction`, is the lock.
- `listPageStates(sourceId, slug)` (`replaceableFile`): the page row's body, frontmatter, title, type and tags, then the 20 newest
  `page_versions` rows that hold a body, newest first.

`facts/fence-fact-append.ts`
- `countSegmentedVersionsOfPage(sourceId, slug)` (`heldRowsInVersions`): how many of the page's versions are `segmented`.
### Phantom redirect (`facts/phantom.rs`, `links/phantom_merge.rs`, family `facts_phantom`)

Twelve store methods serve the fourteen phantom-redirect members; `maxFenceRowNumOfPage` and `readFenceRowNumHint` call
`maxFenceRowNum` (`facts/cycle.rs`), which runs the same `MAX(row_num)` statement. Each method takes one JSON object in
`camelCase` and refuses an unknown key, except `listOntologyObservationSlugs` (the source id), `pageHasTimelineEntries`
(the page id or null) and `listOwnLinkIds` (the page id).

- The reads answer in fact or link id order, and `listRootPageSlugsAfter` and `listOntologyObservationSlugs` in byte
  order of slug; the statements set no order (or `ORDER BY slug`), and their callers depend on none.
- `moveFactToPage` runs the withdrawal guard before it writes, as `facts_preserve_withdrawal` fires on its `SET` of
  `entity_slug` and `expired_at`, then writes through the fact writer (trust stamp, purge ledger, by-page index and
  unique fence key). A row number another fact of the page holds refuses with `constraint_violation`; a row number
  that is not an `integer` refuses with `invalid_argument`. A fact of another source, or no fact, is left alone.
- `repointInboundLinks` and `repointOutboundLinks` move each link under its own id, in one transaction. A link whose
  new identity (`from_page_id`, `to_page_id`, `link_type`, `link_source`, `origin_page_id`, nulls equal) another link
  held before the statement ran stays; so does a link that would point a page at itself. A move onto a page id no
  page has refuses with `constraint_violation`, as the `links` foreign keys do.
- `listFactIdsStillOnPage` has no source filter, as its statement has none.

## Purge, held-move and purge receipt statements (`engine-sql/facts-purge.ts`, Rust engine lane 4 item 4.2)

The statements `facts/gone-page-facts.ts`, `facts/purge-reasons.ts`, `facts/held-fact-move.ts` and
`facts/purge-verify.ts` ran through `executeRaw` are 34 typed members, so the Rust arm answers each
with the typed `raw_sql` refusal until the store holds what it reads. The ten held-move members are served by
`facts/held_moves.rs` (see "Held moves" below), `expireFactsOfGonePages` by `facts/rest_sites.rs`, and the purge
receipt reads by `facts/purge_receipt.rs` and `facts/purge_plan.rs` (see "Purge receipt reads" below), the journal
statements by `facts/purge_journal.rs` and `persistence/purge_effects.rs` (see "Purge journal statements" below), the
reason tombstone write by `writeReasonPurgeTombstones` (see [sources.md](sources.md)), and the derivation probe by
`page_body/purge_probe.rs` (see [purge-plan.md](purge-plan.md)), and `listBeliefEventsForPurgeProbe` by the store's belief
ledger (`trust::belief_purge`, see [trust.md](trust.md)). The other 1 has no Rust implementation yet, and `test/engine-parity/facts-purge-sites.test.ts` stops on that refusal for their cases. The Postgres text of each
statement is pinned byte for byte by `test/facts-purge-sites-sql-pin.test.ts`.

| Member | What it does |
|---|---|
| `expireFactsOfGonePages` | Expires the facts a retention purge takes with its deleted pages (filed on them, their conversation slots, extracted from them, about them and held by no page): four updates in order over the paired source ids and slugs. Writes facts; run it in the purge transaction. |
| `readPurgeSourceLocalPath` | The source's checkout path, null for none or no such source. Reads sources. |
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
| `listBeliefEventsForPurgeProbe` | The next 1000 belief events of the source after id `after` with a recorded value, in id order. Reads belief_events. The store keeps no row for a recorded JSON-null value, so it returns fewer raw rows than PGLite and Postgres (2 against 5 in `test/engine-parity/belief-purge-probes.test.ts`); the purge receipt's report skips null values, so its bytes match on every engine. |
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

### Held moves (`facts/held_moves.rs`, family `facts_held`)

Served on Rust: `heldEntityPageDeleted`, `heldTargetPageLive`, `readHeldAccessState`, `listHeldMoveRows`,
`listStruckHeldRows`, `readHeldRowVisibility`, `heldMoveDue`, `readHeldConfigValue`, `readHeldPageLocation` and
`readHeldVersionsEdited`. A holding page is `memory/unattributed` at any depth, and a held row is an unexpired fenced
fact on one that names another entity.

- `readHeldAccessState` reads the folder rules and pending prefixes the access rules family keeps (`access_rules.rs`):
  `page_rule` is a rule or pending prefix exactly the entity, `restricted` a folder rule or pending prefix that covers it,
  and `unreadable` is always false (no row-level security). `heldMoveDue` is true when a held row's entity has a folder
  rule id its holding page lacks, or a pending prefix covers the entity and not the holding page.
- `readHeldRowVisibility` is `page_hidden` over the live page of the source (private, `readable_by` or an access alias
  hides it); no live page is none.
- `listStruckHeldRows` is the newest expired id per holding page and row number that no active row reuses. The store
  never reuses a struck row number, so the PGLite `DISTINCT ON` over several struck rows of one number has no Rust case.
- `readHeldPageLocation` ignores `timeoutMs`: the read has no server statement to end.
- `readHeldVersionsEdited` scans the journal for the request id (compared in lower case; a non-UUID is
  `invalid_argument`) and reads `held_versions_edited.segmented_versions_not_edited` from the first admitted request
  when several principals share the id; none recorded is 0.
- A NUL byte in a text argument is `invalid_argument`.

The parity cases seed facts, pages, versions, chunks, timeline entries, write requests and effects through the
typed writers. `belief_events`, `page_segment_derivations` and `takes` have no typed fixture, so their members
are compared on empty data only.

### Purge receipt reads (`facts/purge_receipt.rs`, family `facts_purge_receipt`)

Served on Rust: `readPurgeSourceLocalPath`, `readPurgeReceiptSourcePath` (both the store's `readSourceLocalPath`),
`listSegmentedPageBodies`, `listSegmentedVersionBodies`, `listFactContextsForPurgeProbe`,
`listPageSourcePathsForPurge`, `countLegacyDerivedPages`, `vacuumPurgedTables`, `listPageProseHits`,
`countPurgeFingerprintResidue` and `listNearestFactsForPurge`.

- `listSegmentedPageBodies` and `listSegmentedVersionBodies` read a body as segmented when the page or version
  records segmented storage; a negative or fractional limit refuses before the call.
- `listPageSourcePathsForPurge` returns its paths in byte order. Postgres returns `DISTINCT` rows in no stated
  order, so the parity case sorts them.
- `listPageProseHits` orders slugs in byte order; Postgres orders them by the database collation. A null column
  holds no needle, and only the `pages` store skips soft-deleted pages, as in the SQL.
- `countLegacyDerivedPages` counts a live page of type `atom`, or with frontmatter `dream_generated` true (boolean or
  the text `"true"`), that has no `derivation_inputs` row naming it as the derived page.
- `countPurgeFingerprintResidue` counts takes on pages of the source whose slug is the subject (or any page for
  `*`), with no active or expiry filter, as the SQL has none.
- `vacuumPurgedTables` has nothing to compact and resolves once the store is open; `withQueryCache` changes nothing.
- `listNearestFactsForPurge` ranks the source's facts (expired ones too) that hold a vector of the model by cosine
  distance to the target, NaN after every number and equal distances by id, and keeps five. `contains_claim` is
  `strpos(gbrain_fact_normalize(fact), gbrain_fact_normalize(claim)) > 0`, so an empty claim is in every fact. A
  vector of another width refuses, as `<=>` refuses it, and the caller reports the probe skipped.
- `listBeliefEventsForPurgeProbe` is not served and refuses by name. An empty answer would let a purge receipt report
  `belief_events` clean on a store that records belief events, so the probe fails closed until the store reads
  `belief_events` in keyset pages.

### Purge journal statements (`facts/purge_journal.rs`, family `facts_purge_journal`)

Served on Rust: `readDeletePageRequest` and `listPurgeEffects` (`facts/purge_journal.rs`); `listPageChangeReasons`
and `listRequestsRecordingReasons` (`facts/page_purge_journal.rs`); `listGitEffectsCarryingReason`, `listPageGitEffectsForStrip` and
`setPurgeEffectData` (`persistence/purge_effects.rs`); `countPagePurgeTombstones` (`facts/page_purges.rs`); and the
reason tombstone write `insertReasonPurgeTombstones` (the `reason_tombstones.rs` family, see [sources.md](sources.md)).
They read the write journal's requests and effects (`persistence.rs`).

- The Git effect reads take no row lock (`FOR UPDATE OF e`): a store write runs alone. Each row carries the
  `request_id` of the request with the effect's journal id; an effect with no such request is left out, as the
  inner join leaves it out.
- `listPageGitEffectsForStrip` counts a `commit_line`, `commit_trailers` or `commit_trailer` key with a JSON null
  value as present, as `data->'k' IS NOT NULL` does.
- `setPurgeEffectData` refuses an `effectId` that is not a bigint, as `$1::bigint` does; an unknown id changes nothing.
- `listPageChangeReasons` returns each reason once, null included, in byte order (null first). Postgres `UNION`
  returns them in no stated order, so the parity case sorts them.
- `readDeletePageRequest` and `listPurgeEffects` refuse a request id that is not a UUID with `invalid_argument`.
  `listPurgeEffects` orders kinds in byte order; Postgres orders them by the database collation, which agrees for
  the lower-case kinds the journal writes. A `parked` value that is not an array refuses, as
  `jsonb_array_length` does.

### Claim conflicts, contested proposals, live entity page and gone-page expiry (`facts/rest_sites.rs`, family `facts_rest`)

Served on Rust: `listClaimConflictPairs`, `countClaimConflictPairs`, `listUnarchivedSourceIds` (the same store read as
`listActiveSourceIds`), `readLiveFactEntityPage`, `listContestedProposalPairs`, `lockAgentWritebackSetting` and
`expireFactsOfGonePages`.

- The claim pairs follow the SQL: active typed claims of the source (`source` not in the audit list), joined on entity,
  visibility, metric, unit, period (null-safe) and as-of bucket with a different value, the older claim by `valid_from`
  then id. A pair on an owned memory page needs both claims on the same page. A decide proposal in any status covers its
  pair, and so does a pending `supersede_fact` proposal between two facts; a rejected one does not. The bucket is the
  UTC day, or the ISO week, month, quarter or year the period names (`weekly`, `monthly`, `quarterly`, `annual`,
  `annually`, `yearly`, trimmed of spaces and lower-cased). `cap` is a non-negative whole number; the count ignores it.
- `listContestedProposalPairs` lists each pending decide proposal that names a listed fact, once per listed fact that
  names it, by proposal id then by the order of `ids`, when both facts are active, in the source of the proposal and
  readable (world only for a remote caller, the fact privacy policy, the page and quarantine rules, and the trust
  floor).
- `readLiveFactEntityPage` is none for a soft-deleted page or one the remote page-read floor hides. Its TypeScript
  member uses `storePageTextPolicy(remoteReadFloorSql)`, which serves supported labelled-only callers, including
  lineage reads, and ordinary callers carrying pending folder prefixes when their policy text matches. This is
  distinct from the fact-provenance floor (`storeFloorPolicy`) and the non-owner lineage fact-policy refusal.
- `expireFactsOfGonePages` expires, in one write, the facts filed on a gone page (an ontology observation is not
  filed there), the conversation slots filed on it (the row gives up its dimension, value and slot), the facts extracted
  from it and filed on none, and the facts about it that no other page row holds. The first rule that matches a row
  decides it, and a pair with no partner (the lists differ in length) matches nothing. Callers reach it inside a
  `transaction`, which the Rust engine does not serve yet, so a purge or a page delete still stops at `transaction`; the
  parity case calls the member directly.
- `lockAgentWritebackSetting` takes no lock: the store has one writer. It is reached only inside a `transaction` too.
- A NUL byte in a text argument is `invalid_argument`. A text comparison is a byte comparison.

## Fact purge plan, transaction and segment-storage statements (`engine-sql/facts-purge.ts`, Rust engine lane 4 item 4.2)

The statements `facts/purge.ts` ran through `executeRaw` are 35 typed members, so the Rust arm answers each with the
typed `raw_sql` refusal until the store holds what it reads. `lockPurgeSource` (the source record's incarnation and
archived flag; the purge transaction is the store's single writer, so FOR UPDATE changes nothing) and the tombstone
writes `insertFactPurge` and `insertTakePurge` have Rust implementations, as do the Git effect statements
(`listGitEffectsCarryingReason`, `listPageGitEffectsForStrip`, `setPurgeEffectData`; persistence.md, "Purge effect
statements") and `countPagePurgeTombstones` (`facts/page_purges.rs`). A whole `purge_fact` on the Rust arm admits its
write request, then stops on the refusal of `deletePurgeReviewQueue`, and its transaction keeps nothing
(`test/engine-parity/fact-purge-commit.test.ts`). The parity file
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
| `listPurgeVersionBodies` | The next 5000 inline saved versions of the source after id `after` that belong to one of the pages or carry the lowered claim in their body, timeline or title (or the escaped claim in their frontmatter text), in id order, each with `metadata` when the title or frontmatter carries it (`purge_version_bodies.rs`). Reads page_versions and pages. |
| `redactVersionChangeReasons` | Overwrites the change reason of every saved version of the source's pages that quotes the claim (lowered plain form or folded reason form) with `[purged]`; the ids redacted. Writes page_versions. |
| `listSegmentedVersionsForPurge` | The next 5000 segmented saved versions of the source after id `after` that belong to one of the pages or whose generation holds the lowered claim, in id order. Reads page_versions, pages, page_body_manifest and page_segment_texts. |
| `abortPurgedStagings` | Aborts the uncommitted stagings with these ids; the page ids they belonged to (none for a staging with no page). Writes page_body_stagings; run it in the purge transaction. |
| `deletePurgedStagingParts` | Deletes the upload parts of these stagings; how many. Writes page_body_staging_parts; run it in the purge transaction. |
| `deletePageViewDigests` | Deletes the cached read-view digests of these pages. Writes page_view_digests; run it in the purge transaction. |
| `deleteUnreferencedPurgedTexts` | Deletes the source's segment texts that no manifest row references and that were replaced by the purge (`replaced` are their sha256 digests) or hold the claim, plain or as a fence cell stores it; how many. Writes page_segment_texts; run it in the purge transaction. |
| `listPurgeMatchCandidates` | The first 25 facts of the source whose text contains `text` (case folded), in id order, each cut to 160 characters. Reads facts. |
| `lockPurgeSource` | Locks the source row for the purge transaction and returns its incarnation and archived flag, null for no such source. Reads sources; run it in the purge transaction. |
| `insertHoldingPagePurges` | Stores a purge tombstone for each holding page that holds one of the facts about an entity with no page of its own, none twice. Writes fact_purges; run it in the purge transaction. |
| `insertTakePurge` | The one writer of text-free take purge tombstones, none twice: a `TakePurgeInsert` row names one claim fingerprint (`claimHash`) or a page (`pageId`, one tombstone per distinct take claim of the page) under the subject, and the answer is true when any tombstone was new. Writes take_purges; run it in the purge transaction. Served on Rust (see the take purge ledger section). |
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
| `deletePurgedChunks` | Deletes the chunks of these pages and voids the text projection that certified them; returns how many chunk rows were deleted. Writes content_chunks and pages; run it in the purge transaction. |
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
those members are compared on empty tables only; `insertTakePurge` is compared by its
boolean (true, then false for the same key) and by the refusals its tombstones cause (take-purge-ledger.test.ts). `insertHoldingPagePurges` is compared by the claim checks that read its tombstones back
(holding-page-purges.test.ts).

## Fence reconcile and deleted-page expiry (`facts/cycle_fence.rs`, family `facts_cycle_fence`)

The statements `runExtractFacts` (`src/core/cycle/extract-facts.ts`) runs on a page's fence rows, which pass 1 of the
maintenance sweep reaches. The SQL is in `src/core/engine-sql/facts-cycle.ts`. Each write goes through `write_fact`, so
the trust stamp, the purge ledger and the unique fence key apply. `updateFenceFactCells` names `visibility` and
`expired_at`, so the withdrawal guard (`preserve_withdrawal`) runs. A statement with no `ORDER BY` answers in id order;
no caller depends on that order. `now()` is the store's clock.

| Member | Answers or writes |
| --- | --- |
| `listFenceRowSupersession(sourceId, slug)` | `{ id, row_num, expired_at, superseded_by }` of the coordinate's rows that hold a `row_num`, by id. |
| `setFactSupersededBy(sourceId, id, supersededBy)` | Sets or clears `superseded_by`. A successor that names no row is refused, as `facts_superseded_by_fkey` refuses it. |
| `expireFactInPlace(sourceId, id)` | `expired_at = COALESCE(expired_at, now())`; the row keeps its number. |
| `expireAndDetachFact(sourceId, id)` | As `expireFactInPlace`, and `row_num = NULL`. |
| `updateFenceFactCells(sourceId, id, cells)` | Writes a fence row's cells onto the fact. A null `validFrom` keeps the stored one; `validUntil` is written only with `setValidUntil`; a null `expiredAt` clears the expiry and a time keeps an existing one. |
| `listHeldWideningFactIds(sourceId, ids)` | `{ id }` for each pending, rejected or undone `supersede_fact` or `confirm` proposal of the source whose related fact is in `ids` and whose before state has a `visibility` key. A fact two proposals hold is named twice. |
| `listDeletedPageSlugsWithActiveFacts(sourceId)` | `{ slug }` of each soft-deleted page of the source that still has an unexpired fence row, in byte order. |
| `listExpirableFactIdsOfDeletedPage(sourceId, slug, pageId)` | `{ id }` of the coordinate's unexpired fence rows when its page is soft-deleted (and, with `pageId`, has that id), by id. |
| `readDeletedPageBody(sourceId, slug)` | `{ compiled_truth, timeline, body_storage }` of the coordinate's soft-deleted page; null when the page is live or missing. |
| `expireFactsByIds(sourceId, ids)` | Expires the unexpired rows of the source among `ids` now; `{ id }` of each row it expired, by id. |

## The fence projection's statements (`facts/fence_projection.rs`, `facts/unwithdrawn_restore.rs`)

A put_page that updates a page with a `## Facts` fence runs these inside its publication
(`src/core/engine-sql/fence-projection.ts`, `engine-sql/trust-fence.ts`); each is the statement the projection and its
fence guard sent through `executeRaw`. The writes join the engine's transaction (`Store::write`). The writer's tier
and the opened fact ids come from the store's write trust context ([`FenceContext`](#the-fence-guards-reads-factsfencers)).
Documents (`incoming`, `fieldRows`, `moves`, `restated`) are `jsonb_to_recordset` text: a non-array, a non-object
record or a field of the wrong type refuses with `invalid_argument`, as Postgres raises; every record is cast before
any row changes. The members add no keys.

- `listPageFenceFactCells(sourceId, slug)`: `{ row_num, fact, visibility }` of the page's positioned facts, any state,
  by id (the SQL sets no order). `hasPositionedPageFacts`: whether one of them is not a conversation-extractor row.
- `expireFenceFacts(sourceId, slug, incoming, ids)`: each positioned fact of `ids` the incoming fence does not state
  as it is, under the retire rules of `listFenceRetireCandidates`, is detached and expired (`expired_at` kept when set,
  else the transaction's now).
- `refreshFenceFactFields(sourceId, slug, fieldRows)`: each record's cells onto the page's fact at its row number (any
  state), `valid_from` kept when the record has none, only when a cell differs (`IS DISTINCT FROM`, NaN equal to NaN);
  a row two records match takes the first. The CHECK constraints apply.
- `detachFenceFactRows(ids)`: facts of any source leave their row number. `moveGuardedFenceRows(moves)`: each fact takes
  its move's row number and visibility; the first move of a fact wins.
- `listOccupiedFenceRowNums`: the row numbers of the page's live facts. `readLiveFenceFactAt(sourceId, slug, rowNum)`:
  `{ id, trust_tier }` of the live fact there. `listFactsAboveWriter`: the page's live positioned facts whose stored
  tier ranks above the writer's, by id.
- `listTrustedPrivateCopies(sourceId, slug, restated)`: per restatement row number, the first live narrower fact more
  trusted than the writer with its claim, the page's own first, then by id: on the page while no live world fact of the
  page states the claim, or of the restatement's entity off the page, still valid, while no live valid world fact of
  that entity states it.
- `readPageInlineBody(pageId)` (the unwithdrawn-facts classifier): `{ id, compiled_truth, timeline, body_storage }`,
  the body columns null for a segmented page. The unwithdrawn-facts restore runs only in a managed publication and is
  not served.

## Derivation inputs (`generations/derivation_inputs.rs`)

`recordDerivationEdges` (the store method is `recordDerivationInputs`) keeps each `derived <- input` edge once
(`ON CONFLICT DO NOTHING`) under `h 0x0A` (by derived row), with its mirror under `h 0x0B` (by input row). A source
delete removes that source's edges; an edge with no source stays. A `sourceId` the store does not hold refuses as
`derivation_inputs_source_id_fkey` does (the engine member throws code 23503) and records nothing. `listDerivedRows`
reads one hop from the input index: the distinct derived rows of the frontier, in byte order of (derived_table,
derived_id), at most `limit`. A NUL in a table or id is `invalid_argument`, as is a negative limit. The SQL is in
`src/core/engine-sql/facts-trust.ts`.

The edges feed three reads besides the walk: `listFactsFromQuotedPages` counts a fact whose recorded input page has a
quoted type (`facts/quote.rs`); the owner-only rule (`owner_only.rs`) hides a page, fact, take or timeline row whose
inputs reach, transitively, a marked row or a row held in an owner-only source (`gbrain_owner_only_lineage_strict`,
through `lineage_reaches`); and a page delete marks every row derived from the page, its takes and its timeline rows
(`owner_only_marks.rs`, `gbrain_owner_only_mark_derived`, through `derived_closure`). `countLegacyDerivedPages`
(`facts/purge_plan.rs`) counts the live atom and `dream_generated` pages of a source that no edge names as derived.

The file is lane 7's `derivation_inputs.rs` (rust-engine/derivation-trust) less `lineage_owner_only` and
`timeline_entry_page`, which read that branch's marks API; `owner_only.rs` runs the same walk over this line's marks.
It holds every line of rust-5a's copy (`5801031e37`), so either merge keeps one store.

## Not modeled

The native fact writer applies the purge-ledger guard and stamps write attribution. Inputs whose PGLite outcome the store cannot
reproduce refuse in the member with `engine_capability_missing`.

## Extract rollup (`facts/extract_rollup.rs`, family `extract_rollup`)

Served on Rust: `upsertExtractRollup` (src/core/engine-sql/extract-bookkeeping.ts). The family also serves the two
doctor reads of the rollup, `brain.readExtractRollup7d({ withExpected })` and `brain.listRecordedHaltReasons7d()`, for
the `readExtractRollup7d` and `listRecordedHaltReasons7d` members (doctor's `extract_health` check).

- The writer is the SQL's insert-or-add. A new `(kind, source_id, day)` row takes the event's values; an existing row
  adds them. `halt_reasons` starts as `{}` with no reason and `{reason: halts}` with one; on conflict a reason adds
  `halts` to its bucket. `updated_at` is the write time.
- `form: 'pre_v141'` is the statement of a brain behind migration v141: it adds the expected-limit stops to
  `halt_count` and leaves `expected_limit_count` and `halt_reasons` alone.
- `cost_usd` is a `REAL`, kept and added as a 4-byte float. A value that does not fit refuses with `invalid_argument`,
  as Postgres's `value out of range` does. Postgres keeps `NaN` and `Infinity` in a `REAL`; the store refuses them.
- The counts are `INT`: a sum past 2^31 - 1 refuses with `invalid_argument`, as `integer out of range` does. A day that
  is not a date refuses as the `::date` cast does.
- The reads take the rows with `day >= CURRENT_DATE - 7`; `CURRENT_DATE` is the UTC date, as the writer's default day
  is. `readExtractRollup7d` resolves one row per kind: the `REAL` sum as a 4-byte float, the `INT` sums,
  `expected_limit_count` (0 when `withExpected` is false), `last_updated_at` as ISO text, and `last_halt_age_days`
  (days since the newest day with a halt; null without one). `listRecordedHaltReasons7d` resolves `{ kind, reason, n }`
  in (kind, reason) order.
- Kinds and reasons sort in byte order. Postgres sorts them by the database collation, which can differ for kinds
  that hold punctuation.
- The table has no foreign key, so deleting a source keeps its rollup rows, as in Postgres.
