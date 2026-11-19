# link_queries: derived links, provenance reads, graph signals and relational walks

Code: `rust/crates/gbrain-store/src/link_queries.rs`, the napi methods in
`rust/crates/gbrain-napi/src/families/link_queries.rs` and the members in
`src/core/rust-engine/store-members/link-queries.ts`. The references are `src/core/engine-sql/links.ts`
(derived-link replacement, `removeLinksByPagesAndSource`, `listLinkSources`, `findOrphanPages`) and
`src/core/search/read-enrichment.ts` (`readBacklinkCounts`, `readAdjacencyBoosts`, `readRelationalFanout`,
`readChainHop`) and `src/core/engine-sql/search-reads.ts` (`hasSupersedeEdges`, `supersedingPageSlugs`,
`pagesLinkingTo`).

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

### Refusals (`engine_capability_missing`)

- Read policy the store does not record: `minTrust`, `suppressFlagged` and any temporal option
  (`temporal`, `wanted`, `lineGrammar`, `temporalBody`), and `excludePrivate` on every member but the three ranking
  reads below. `requireSafeChunks` and `takesHoldersAllowList` are accepted: they turn the live filter on in
  `relationalFanout` and are ignored by `getBacklinkCounts` and `getAdjacencyBoosts`, as in the SQL engines. With
  `requireSafeChunks`, `relationalFanout` and `relationalChainHop` give a page a `canonical_chunk_id` only when it is
  sealed at the safe fence (`chunker_version >= 4`), and `relationalChainHop` applies readChainHop's `textGate` to edge
  context: the TypeScript member reads the caller and sends `textGate: 'body'` (the evidence page must be sealed and hold
  no facts / takes fence; a segmented page's `body_flags.has_protected` decides, fail closed), `'takes'` (an owner call
  whose credential names a holders list: sealed and no takes fence) or none (the owner's own direct call).
- `excludePrivate` on `getBacklinkCounts`, `getAdjacencyBoosts` and `supersedingPageSlugs` is the page policy
  `pageReadFilter` adds, judged by `page_hidden` in `facts/privacy.rs`. The wire scope carries it as `excludePrivate`
  (`{ honorAliases, entityPrivacy, ownerOnly }`, `GraphScope.exclude_private`) and every page the read judges must pass it: the
  target, the linking page and the page that authored the edge. The TypeScript member sends it through
  `storePagePolicy`, which refuses a caller whose policy is wider than the store's. These three members also accept
  and ignore the other keys of hybrid search's option bag, because hybrid search hands them that whole bag as their
  policy; any other key still refuses. The owner-only part of the policy (`ownerOnly`: a page of an owner-only source,
  a concept synthesized from one, or every page under the closed form) applies to each of those pages too. The
  owner-only sources are read once per call, on the first page the call judges (`OwnerOnlyCache`).
- A derived-link origin with a caller-read `snapshot`. `semanticsPrimed` is ignored: the store has no relation
  semantics to prime.
- A page id that is not a 32-bit integer (`getBacklinkCounts`, `getAdjacencyBoosts`, `relationalChainHop`): Postgres
  casts the ids into `int[]`. A non-safe-integer id in `getAdjacencyBoosts` throws the same `TypeError` the SQL engines
  throw, before any option is read.
- A `supersedingPageSlugs` id that is not an integer (Postgres casts into `bigint[]`). Ids below 1 or above the safe
  integer range match no page and are dropped. A `pagesLinkingTo` id that is not a 32-bit integer (the SQL casts into
  `int[]`); ids below 1 are dropped.
- A `relationalFanout` depth or limit, or a `relationalChainHop` `neighborCap`, that is not an integer after the clamp.

## Keys

None today. Every member reads and writes links through the core links helpers (`put_link`, `delete_link`,
`out_links`, `in_links`) and reads pages, chunks and sources through their families' readers. The `q` tag is shared with
wanted_links (`wanted_links.rs`): the bytes after `q <source id> \0 W` are wanted_links', and this family keeps the `W`
sub-tag free. `remove_source_rows` deletes every key under `q <source id> \0`, so it covers both families when
`cascade.rs` removes a source.

## The read filter

`pageReadFilter(alias, scope, params, live)` is modelled for the source clause (`sourceIds` when not empty, else a
non-empty `sourceId`) and the live clause: not soft-deleted, no `quarantine` frontmatter key, and the source exists and
is not archived. The origin clause (`originFilter`) passes a link with no origin, or one whose origin page passes the
live filter.

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
- `relationalChainHop`: one oriented step from the frontier, collapsed per neighbor, ordered by frontier id and lowest
  link id; the degree saturates at 300 (`CHAIN_DEGREE_SATURATION`).
- `hasSupersedeEdges`: true when any `supersedes` link exists, in any source, to any page.
- `supersedingPageSlugs`: `{ to_page_id, by_slug }` rows for `supersedes` links to the listed pages from a page that is
  not soft-deleted and is in the target's source. With a policy (even `{}`), both pages pass the live read filter and
  the link origin, when it has one, passes it too; with no policy a soft-deleted target still counts. Rows come out by
  page id, then slug in byte order, as PGLite's `Unique` over a sort under the C collation emits them, and the member
  keeps the first row per page, so the smallest slug wins. Postgres may plan a hash `DISTINCT`, so its choice among
  several superseders of one page is planner-dependent; the parity cases give each page one superseder.
- `pagesLinkingTo`: the distinct listed linkers with a ranking link (not `amends`) to a listed target, ascending. The SQL
  reads `links` alone, so a soft-deleted linker or target still counts.

## Known differences

- Link temporal state is not modelled: `primeRelationSemantics`, the belief point, `applyTemporalEvidence` and
  `effectiveRanges` have no store counterpart, so every temporal option refuses (follow-up
  `link-temporal-state-not-modeled`).
- `lockPageKeys` is not needed: the store's write transaction is serial.
- `PageSourceMissingError` and the `REVISION_BACKFILL_PENDING` path do not occur: every store page has a source and a
  revision.
- Chronicle-style dates in the SQL engines read the host time zone; the store reads UTC (follow-up
  `chronicle-reads-host-time-zone`).
- The derived-link insert repeats the core `add_links_batch` checks locally (`check_link`, `insert_row`).

## Follow-ups

- `links-insert-link-helper`: after core lands, add `pub(crate) fn insert_link(tx: &mut dyn KvWrite, record:
  LinkRecord) -> Result<bool>` to `links.rs` (accepted) and replace the local `check_link` and `insert_row` copy here.
