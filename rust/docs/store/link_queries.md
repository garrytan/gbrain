# link_queries: derived links, provenance reads, graph signals and relational walks

Code: `rust/crates/gbrain-store/src/link_queries.rs`, the napi methods in
`rust/crates/gbrain-napi/src/families/link_queries.rs` and the members in
`src/core/rust-engine/store-members/link-queries.ts`. The references are `src/core/engine-sql/links.ts`
(derived-link replacement, `removeLinksByPagesAndSource`, `listLinkSources`, `findOrphanPages`) and
`src/core/search/read-enrichment.ts` (`readBacklinkCounts`, `readAdjacencyBoosts`, `readRelationalFanout`,
`readChainHop`), `src/core/engine-sql/search-reads.ts` (`hasSupersedeEdges`, `supersedingPageSlugs`,
`pagesLinkingTo`) and `src/core/engine-sql/link-reads.ts` (the site reads below, in
`rust/crates/gbrain-store/src/link_queries/site_reads.rs`).

## Members

| Member | State |
|---|---|
| `replaceDerivedLinks(origin, links, opts?)` | served |
| `replaceDerivedLinksBatch(items)` | served; every origin in one write transaction |
| `removeLinksByPagesAndSource(pages, { linkSource?, keepTypedNerPairs? })` | served |
| `listLinkSources({ sourceId?, sourceIds? })` | served |
| `rewriteLinks(...)` | served; a no-op, as in the SQL engines |
| `getBacklinkCounts(ids, scope?)` | served |
| `getAdjacencyBoosts(ids, scope?)` | served |
| `relationalFanout(seeds, opts?)` | served |
| `relationalChainHop(frontier, opts)` | served |
| `findOrphanPages({ sourceId?, sourceIds?, mode?, scopeInbound? })` | served |
| `hasSupersedeEdges()` | served |
| `supersedingPageSlugs(ids, policy?)` | served |
| `pagesLinkingTo(fromIds, toIds)` | served |
| `inboundLinkCoverage({ sourceIds? })` | served |
| `listJunkEntityHubs({ edgeThreshold, maxChunks, limit })` | served |
| `countEntityPages(filter, { sourceId?, excludeQuarantined? })` | served |
| `entityGraphCoverage(filter)` | served |
| `entityFeatureCoverage(filter, feature, { samplePercent? })` | served; a `samplePercent` refuses |
| `countDatedMeetingPages()` | served |
| `countForeignEdges(slug, sourceId, direction)` | served |
| `listLivePageSummaries(scope?)` | served |
| `countInboundLinks(slug, sourceId, { excludePrivate, originSameSource })` | served |
| `readEntityInboundEdges(slug, sourceId, { excludePrivate, originSameSource })` | served |
| `listLinkEndpointPages(sourceId, slugs, crossSourceSlugs)` | served |
| `listPagesTitledIn(queryLower, scope)` | served |
| `probePageTypes(sets, scope)` | served |
| `readLongPageSizes(ids, scope, { includeTimeline })` | served |
| `wordLexemes(words)` | served under the English text search configuration |
| `readLinkContextMatches(asks)` | served |
| `readLinkContextOriginPages(ids)` | served |

### Refusals (`engine_capability_missing`)

- The temporal read option (`temporal`) on every member but `relationalFanout` and `relationalChainHop`. `minTrust` and `suppressFlagged` are served wherever `pageReadFilter` reads
  them (`getBacklinkCounts`, `getAdjacencyBoosts`, `supersedingPageSlugs`, `relationalFanout`, `relationalChainHop`,
  `listLivePageSummaries`, `listPagesTitledIn`, `probePageTypes`, `readLongPageSizes`): `GraphScope` applies `trust::TrustPolicy` to the page's stamped tier
  and its write-gate receipts. `findOrphanPages` and `listLinkSources` still refuse them: their SQL does not read
  them through `pageReadFilter`, and no caller passes them. `takesHoldersAllowList` is accepted: it turns the live
  filter on in `relationalFanout` and is ignored by `getBacklinkCounts` and `getAdjacencyBoosts`, as in the SQL
  engines. `requireSafeChunks` is accepted everywhere `pageReadFilter` does not read it, and the relational walks model
  it: `relationalFanout` and `relationalChainHop` give a page a `canonical_chunk_id` only when it is sealed at the safe
  fence (`chunker_version >= 4`; a page that records no version is not safe), and `relationalChainHop` applies
  readChainHop's `textGate` to edge context. The TypeScript member reads the caller and sends `textGate: 'body'` (the
  evidence page must be sealed and hold no facts / takes fence; a segmented page's `body_flags.has_protected` decides,
  fail closed), `'takes'` (an owner call whose credential names a holders list: sealed and no takes fence) or none (the
  owner's own direct call). An unknown `textGate` is an invalid argument. `getBacklinkCounts`, `getAdjacencyBoosts` and
  `supersedingPageSlugs` also accept and ignore the other keys of hybrid search's option bag
  (`HYBRID_BAG_KEYS`), because hybrid search hands them that whole bag as their policy; any other key still refuses.
- A page id that is not a 32-bit integer (`getBacklinkCounts`, `getAdjacencyBoosts`, `relationalChainHop`): Postgres
  casts the ids into `int[]`. A non-safe-integer id in `getAdjacencyBoosts` throws the same `TypeError` the SQL engines
  throw, before any option is read.
- A `supersedingPageSlugs` id that is not an integer (Postgres casts into `bigint[]`). Ids below 1 or above the safe
  integer range match no page and are dropped. A `pagesLinkingTo` id that is not a 32-bit integer (the SQL casts into
  `int[]`); ids below 1 are dropped.
- A `relationalFanout` depth or limit, or a `relationalChainHop` `neighborCap`, that is not an integer after the clamp.
- A `listJunkEntityHubs` threshold, chunk cap or limit that is not a safe integer, or a negative limit.
- `wordLexemes` under any text search configuration other than English: the store has only the English stemmer.

## Keys

None today. Every member reads and writes links through the core links helpers (`put_link`, `delete_link`,
`out_links`, `in_links`) and reads pages, chunks and sources through their families' readers. The `q` tag is shared with
wanted_links (`wanted_links.rs`): the bytes after `q <source id> \0 W` are wanted_links', and this family keeps the `W`
sub-tag free. `remove_source_rows` deletes every key under `q <source id> \0`, so it covers both families when
`cascade.rs` removes a source.

## The read filter

`pageReadFilter(alias, scope, params, live)` is modelled for the source clause (`sourceIds` when not empty, else a
non-empty `sourceId`) and the live clause: not soft-deleted, no `quarantine` frontmatter key, and the source exists and
is not archived. Under `excludePrivate` (the store page policy of `private-provenance.ts`, `page_hidden`), a page the
policy hides fails the filter, live or not, in `getBacklinkCounts`, `getAdjacencyBoosts`, `relationalFanout`,
`relationalChainHop` and `supersedingPageSlugs`. `findOrphanPages` drops a hidden candidate and ignores an inbound link
from a hidden page or with a hidden origin (`privateLinkOriginFilterForCaller` tests the origin's privacy only, not
whether it is live). The origin clause (`originFilter`) passes a link with no origin, or one whose origin page passes the
live filter. The policy carries a caller's reader identity and private-readable grant (the `callerReaders`
opt-in), in these reads and in `listLivePageSummaries`, `listPagesTitledIn`, `probePageTypes`, `readLongPageSizes` and `countInboundLinks`; any other caller
whose policy differs (folder grants, lineage, an owner read) refuses. The owner-only part of the policy (`ownerOnly`: a
page of an owner-only source, a concept synthesized from one, or every page under the closed form) applies to each page
the read judges, with the owner-only sources read once per call, on the first page the call judges (`OwnerOnlyCache`).

## Derived-link replacement

The TypeScript member normalizes each origin with a local copy of `derivedLinkRows` (dedup, source ids filled in) and
sends every item in one store call. The store checks each origin in order inside one write transaction:

1. `expectedRevision` must be a UUID (`bad_revision`, mapped to `TypeError`).
2. The live origin's `knowledge_revision` must equal `expectedRevision` (`null` means absent). A miss is a
   `revision_conflict` naming the item and the current revision; the member throws `PageRevisionConflictError`.
3. The source incarnation must match and the origin must be live (`origin_changed`).
4. With `includeFrontmatter` and no `preserveExisting`, no frontmatter edge touching the origin may lack an origin
   (`provenance_required`).
5. Each row's endpoints must be live (`endpoint_missing`), and each `expectedEndpoints` entry must still carry its
   revision (`endpoint_changed`).
6. Reversed `attended` rows need a meeting origin and revision-bound person endpoints (`attendance_origin`,
   `attendance_person`).

The replace path deletes the origin's links whose producer is listed (authored by the origin, or body producers
`markdown` and `wikilink-resolved` with no origin that leave it) and inserts every row. The `preserveExisting` path
keeps rows whose identity `(from, to, type, producer, origin slug)` is still wanted, rewrites their context and
origin field in place, deletes the rest and inserts the new ones. A row that does not insert is `not_persisted`. Any
error rolls back the whole batch.

## Reads

- `listLinkSources`: counts per `link_source`, count descending, then name ascending with no source last. A scoped read
  counts an edge only when both endpoints, and a live origin when it has one, are in scope.
- `findOrphanPages`: live candidates ordered by slug, then source. `inbound` mode drops a page with any live inbound
  link; `islanded` (the default) also drops a page with an outbound link to a live page. `scopeInbound` limits the
  counted linkers to the scope.
- `getBacklinkCounts`: distinct linking pages per listed page, excluding self-links, the `mentions` producer and
  non-ranking types (`amends`). When options were given, the target, each linker and each link origin must pass the
  live filter; the trusted unscoped call counts every page.
- `getAdjacencyBoosts`: in-set linkers per page over the subgraph the ids induce, with the cross-source subset.
- `relationalFanout`: every simple path from the seeds up to `depth` hops, grouped per reached page; the best path is
  the one with the lowest `(hop, path length, path text)`. `canonical_chunk_id` is the lowest-index chunk of the page's live body (`chunkGenerationProbe`): a staged chunk, one whose occurrence a deferred retire closed and an inline chunk left on a segmented page are never named.
  With `temporal`, a step keeps an edge only while `relationshipFilterSql` would: the edge's relationship row in the
  `world` scope with `excludePrivate`, else `all`, matches the status (`live`, `ended`, `all`) on `asOf` (today, UTC,
  from the store clock, when absent) or overlaps `during`. An edge with no relationship row passes, and an `amends`
  edge passes outside `ended` reads (`edge_filter.rs`).
- `relationalChainHop`: one oriented step from the frontier, collapsed per neighbor, ordered by frontier id and lowest
  link id; the degree saturates at 300 (`CHAIN_DEGREE_SATURATION`). With `temporal`, both the step edges and the edges
  the degree counts pass the same relationship filter as `relationalFanout`, scoped by the hop's `excludePrivate`.
- `hasSupersedeEdges`: true when any `supersedes` link exists, in any source, to any page.
- `supersedingPageSlugs`: `{ to_page_id, by_slug }` rows for `supersedes` links to the listed pages from a page that is
  not soft-deleted and is in the target's source. With a policy (even `{}`), both pages pass the live read filter and
  the link origin, when it has one, passes it too; with no policy a soft-deleted target still counts. Rows come out by
  page id, then slug in byte order, as PGLite's `Unique` over a sort under the C collation emits them, and the member
  keeps the first row per page, so the smallest slug wins. Postgres may plan a hash `DISTINCT`, so its choice among
  several superseders of one page is planner-dependent; the parity cases give each page one superseder.
- `pagesLinkingTo`: the distinct listed linkers with a ranking link (not `amends`) to a listed target, ascending. The SQL
  reads `links` alone, so a soft-deleted linker or target still counts.

### Site reads (`link-reads.ts`)

These replace `engine.executeRaw` statements in doctor, orphans, graph-query, the entity card, automatic link
preparation, entity anchoring and fact relevance. Each keeps its statement's tests: "live" is `deleted_at IS NULL`
alone unless the statement also applies `pageReadFilter(.., live)`.

- `inboundLinkCoverage`: `{ livePages, linkedPages }`; a linked page is the target of any link. `sourceIds`, when
  present (even empty), filters the pages.
- `listJunkEntityHubs`: live pages with more than `edgeThreshold` link ends (a self-link counts twice), at most
  `maxChunks` chunks and no `junk_hub_exempt: true`, with their connector-source mark and canonical twin, most edges
  first. The SQL leaves equal edge counts to the plan; the store breaks them by page id.
- `countEntityPages`: live entity pages. With `excludeQuarantined` it counts the unquarantined ones in every source
  (the SQL ignores `sourceId` there); otherwise a non-empty `sourceId` filters.
- `entityGraphCoverage`: `{ entities, connected, withTimeline }` over live, unquarantined entity pages that are not test
  fixtures (`tools/gbrain/test/`) or the person template. `withTimeline` counts pages with a timeline row.
- `entityFeatureCoverage`: `{ sampleSize, matched }` over live, unquarantined entity pages in every source: the page
  count, and how many are the target of a link (`links`) or have a timeline row (`timeline`). PGLite and Postgres take
  an optional `TABLESAMPLE BERNOULLI` percent; the store reads every page, so a `samplePercent` refuses with
  `engine_capability_missing`.
- `countDatedMeetingPages`: live pages of type `meeting` with an effective date.
- `countForeignEdges`: links of one page, whose other end is in another source; `in`, `out` or `both` (each link once).
- `listLivePageSummaries`: `{ slug, type, quarantined }` for pages that are not soft-deleted and pass
  `pageReadFilter(.., scope)`, in page id order.
- `countInboundLinks`: inbound links from live pages of the same source, `mentions` left out. With `excludePrivate`
  the referrer and the link origin must be readable; with `originSameSource` an origin must be live and in the source.
- `readEntityInboundEdges`: the links `countInboundLinks` counts, in link id order, with the referrer's slug and the
  temporal columns of the link's relationship in the `world` scope with `excludePrivate`, else `all`; all null when
  there is no relationship row. The shim turns the two timestamps into `Date`, as Postgres returns them.
- `listLinkEndpointPages`: the live pages of `sourceId` named in `slugs` (by slug), then, for slugs in
  `crossSourceSlugs` or with no row in `sourceId`, the live pages of other sources (source order, then slug). The SQL
  leaves the row order to the plan.
- `listPagesTitledIn`: pages whose lowercased title (three characters or more) occurs in `queryLower` and that pass
  `pageReadFilter(.., scope, live)`, by source then slug in byte order, at most 50.
- `probePageTypes`: search's type-filter probe (engine-sql/cli-reads-ops.ts). `present[i]` is whether a page that
  passes `pageReadFilter(.., scope, live)` has a type in `sets[i]` (false for an empty set). `available` is null unless
  a non-empty set has no such page; then it lists at most 500 distinct types of those pages. The SQL leaves which 500
  and their order to the plan; the store returns the first 500 in byte order, and the caller sorts them.
- `readLongPageSizes`: search's long-page size preflight (search/long-page-sizes.ts). One row `{ id, chars, bytes }`
  per page in `ids` that passes `pageReadFilter(.., scope, live)` and `servedTextProjectionFilter`, and
  `safeChunksFilter` when `requiresSafeChunks(scope)`. `chars` and `bytes` are the compiled truth's `char_length` and
  `octet_length` (NULL counts 0); with `includeTimeline`, a timeline that holds a character outside `[[:space:]]` adds
  `TIMELINE_SEPARATOR` (21) and its own length. The SQL leaves the row order to the plan; the store returns rows in
  first-ask order, once per id, and the caller reads them into a map. An id that is not a 32-bit integer throws a
  `TypeError` before the store is called, as the SQL's `int[]` cast fails.
- `wordLexemes`: each word's `tsvector_to_array(to_tsvector('english', w))`, in tsvector order. The member returns a
  `Map` from word to lexemes.
- `readLinkContextMatches`: for each ask (a returned link context and its stored edge: from page, to page, link type;
  the pages deleted or not), the links of that edge whose context is the ask's text or, for a text that ends in `…`,
  starts with the text before it (counted in characters). `page_id` is the link's origin page (its from page when it
  has none) when that page is live, else null. Ask order, then link id order; the SQL leaves the order to the plan. A
  stored context is never NULL here, so an ask of `…` alone matches an empty context the SQL engines can store as NULL.
- `readLinkContextOriginPages`: `{ id, source_id, slug, compiled_truth, timeline }` of the pages named in `ids`
  (deleted or not) that are not segmented shells, by id. The SQL leaves the order to the plan.

## Known differences

- Link temporal state is served by the link_temporal family ([link_temporal.md](link_temporal.md)): a derived-link
  publication takes `snapshot`, `lineGrammar`, `wanted` and `temporalBody`. The link write, wanted rows, temporal
  evidence and relationship state share one transaction, including every origin in a batch. Relation semantics are
  primed before publication unless `semanticsPrimed` is true for every item.
- `lockPageKeys` is not needed: the store's write transaction is serial.
- `PageSourceMissingError` and the `REVISION_BACKFILL_PENDING` path do not occur: every store page has a source and a
  revision.
- The derived-link insert repeats the core `add_links_batch` checks locally (`check_link`, `insert_row`).

## Follow-ups

- `links-insert-link-helper`: after core lands, add `pub(crate) fn insert_link(tx: &mut dyn KvWrite, record:
  LinkRecord) -> Result<bool>` to `links.rs` (accepted) and replace the local `check_link` and `insert_row` copy here.
