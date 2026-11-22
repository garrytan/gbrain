# The brain store: link temporal state

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A temporal link type (`works_at`, `advises`, `founded`, ...; `src/core/link-validity.ts`) carries dated evidence: the
transitions a page's timeline or a manual `--valid-from`/`--valid-until` records, and one state row per relationship and
read scope (`all`, `world`) that the entity card, the relationship notes and `doctor` edge_validity read. PGLite and
Postgres keep them in `link_transitions` and `link_relationships` and run the SQL in
`src/core/engine-sql/link-temporal.ts`. The store keeps one record per row
(`crates/gbrain-store/src/link_queries/link_temporal.rs`). On every engine the state itself (stints, status, evidence
hash) is built by the same TypeScript builder in `src/core/link-relationships.ts`; the store only reads the evidence and
writes the rows the builder returns.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readLinkRelationshipEvidence({ keys, originPolicy })` | the links, transitions and current state rows of each key, in the shape `readLinkRelationshipEvidence` returns | `readLinkRelationshipEvidence` |
| `brain.writeLinkRelationshipState(write)` | the number of state rows inserted, updated or retired | `writeLinkRelationshipState` |
| `brain.linkRelationshipKeysForPages(pageIds)` | the keys with evidence touching these pages (as from, to or origin page) | `linkRelationshipKeysForPages` |
| `brain.staleLinkRelationshipKeys(limit)` | the keys whose state row is missing or whose evidence moved, at most `limit` | `staleLinkRelationshipKeys` |
| `brain.linkRelationshipKeysForOrigin(pageId)` | the keys whose evidence this origin page owns | `linkRelationshipKeysForOrigin` |
| `brain.linkRelationshipKeysTouching({ pairs, fromPages, linkTypes })` | the temporal keys of these slug pairs or from pages (store only: the link writes call it before and after they write) | the refresh inside `addLink`, `addLinksBatch`, `removeLink` and `removeLinksByPagesAndSource` |
| `brain.applyLinkTemporalRows(input)` | `{ inserted, liveTargets, keysAfter }`: the origin's owned transitions replaced and the link tense stamped | `applyLinkTemporalRows` |
| `brain.writeManualLinkTransitions(input)` / `brain.removeManualLinkTransitions(input)` | the transitions written / the keys whose manual transitions were removed | `writeManualLinkTransitions` / `removeManualLinkTransitions` |
| `brain.listRelationshipNoteRows({ subjects, excludePrivate })` | the state relations of the subjects with live targets | `listRelationshipNoteRows` |
| `brain.edgeValidityCounts({ sourceIds, staleLimit })` | `{ byStatus, stale, proposals }` | `edgeValidityCounts` |
| `brain.listPageStatusByRef(...)` / `brain.listRecordMetadataRows(...)` | the frontmatter `status` of each ref / the status and supersession links of referring pages | `listPageStatusByRef` / `listRecordMetadataRows` |
| `brain.countSearchVectorRows()` | `{ pages, chunks }`: every page (deleted ones too) and every chunk | `countSearchVectorRows` |
| `brain.countPendingProjectionPages({ scope, relevance })` | `{ total, could_affect, capped, top_counted?, could_affect_images }`: the live pages in scope whose text projection waits and needs work, at most 1000 | `countPendingProjectionPages` |
| `brain.projectionRebuildProgress(scope)` | `{ done, total, pages_per_second }` while a `protocol_activation` job waits on a live `text` page in scope, else null | `projectionRebuildProgress` |
| `brain.readProjectionReadinessGeneration()` | `<brain id>/<commit sequence>`: every commit advances it, so a cached probe answer lasts until the next write; null inside a transaction | `readProjectionReadinessGeneration` |
| `brain.readProjectionReadiness(scope)` | `{ pending, by_design }`: whether a waiting page in scope needs work, and when none does, whether protected images wait | `readProjectionReadiness` |

## Rules

- `scope` is `all` or `world`, `semantics` is `state` or `event`, a transition `kind` is `start` or `end`, a precision is
  `day`, `month` or `year`. Any other value is refused with `constraint_violation` (the tables' CHECKs).
- `valid_ranges` is stored and returned in the text form Postgres prints for a `datemultirange` (`{[2019-02-01,2025-03-01)}`).
- The privacy policy of the world scope (`originPolicy`, `excludePrivate`) uses the store's page privacy rules
  (`facts::page_hidden`), the same rules `privatePagesFilterFragment` composes in SQL. `listRelationshipNoteRows`, `listPageStatusByRef` and
  `listRecordMetadataRows` carry a caller's reader identity and private-readable grant in the policy (the
  `callerReaders` opt-in of `storePagePolicy`); any other caller whose policy differs (folder grants, lineage, an owner
  read) refuses.
- A repeated refresh over unchanged evidence writes nothing and returns 0.
- `applyLinkTemporalRows` replaces the origin's derived transitions: the old rows go before the new rows are written. On
  Postgres the SQL statements are pipelined, which keeps their order only on one connection, so the Postgres member opens a
  transaction when its caller has none (`test/e2e/link-temporal-apply-order-postgres.test.ts`).
- A transition row needs its origin page (`origin_page_id REFERENCES pages(id)`): when a row would be inserted and the
  origin page does not exist in any deletion state, the write refuses with the foreign key's message
  (`link_transitions_origin_page_id_fkey`) and writes nothing. A soft-deleted origin page still exists.

## The call sites and what they run on the Rust engine

| Site | Members | Rust |
| --- | --- | --- |
| `link-relationships.ts` | readLinkRelationshipEvidence, writeLinkRelationshipState, linkRelationshipKeysForPages, staleLinkRelationshipKeys | equal |
| `link-temporal-apply.ts` | linkRelationshipKeysForOrigin, applyLinkTemporalRows, writeManualLinkTransitions, removeManualLinkTransitions | equal |
| `link-relationship-notes.ts` | listRelationshipNoteRows | equal |
| `doctor/checks/edge-validity.ts` | edgeValidityCounts | equal |
| `mentions/referrers.ts` | listPageStatusByRef, listRecordMetadataRows | equal |
| `search/retrieval-coverage.ts` | countEmbeddingHeldPages | equal (always 0: the store keeps no embedding budget rows) |
| `search/retrieval-coverage.ts` | countPendingProjectionPages, projectionRebuildProgress | equal (a capped count refuses: see Known differences) |
| `search/projection-readiness.ts` | readProjectionReadinessGeneration, readProjectionReadiness | equal statuses, cached until the next write |
| `commands/reindex-search-vector.ts` | countSearchVectorRows, replaceSearchVectorTriggerFunction, backfillSearchVectors, ensureFactsKeywordIndex | equal JSON (a no-op under `english`) |

Pinned by `test/engine-parity/link-temporal.test.ts` and `test/engine-parity/retrieval-coverage.test.ts` on every arm.

## Retrieval coverage

The scope of the three coverage reads is `scopeFilter` (`src/core/engine-sql/retrieval-coverage.ts`): the source filter,
the private-page policy (`excludePrivate`, as `storePagePolicy` sends it with `callerReaders`, so a caller's reader
identity and private-readable grant count), live pages only (not soft-deleted, not
quarantined, source present and not archived), the page kind, the types and the excluded slug prefixes. A page waits
when its text projection is neither its knowledge revision nor the pre-activation marker. It needs work unless it is an
image whose body holds a protected fence (`by_design`). The pending count matches a query word as a whole token of
`lower(title || ' ' || slug)`: the TypeScript member turns each `coverageRelevance` pattern back into its word.

## The keyword index rebuild is a no-op

`gbrain reindex-search-vector` rebuilds the SQL engines' `tsvector` columns and triggers for a new text search
language. The store has no `search_vector` column: its keyword index (`R`, `TRIGRAM`) is built from page text at write
time and is the same for every language the store supports. So under `english` (the default, and the only language the
store indexes) `replaceSearchVectorTriggerFunction`, `backfillSearchVectors` and `ensureFactsKeywordIndex` do nothing,
`countSearchVectorRows` returns the counts the SQL engines report, and the command prints the same JSON. Any other
language is refused with `engine_capability_missing` (`keyword_search`) at the first rebuild member.

## Known differences

- The refresh after a link write and the temporal and wanted steps of a derived-link publication are separate store
  calls, not one transaction as on PGLite and Postgres. A crash between them leaves the state rows stale; the next
  `staleLinkRelationshipKeys` sweep finds them. They become one transaction when the transactions core item lands
  (`docs/designs/RUST_ENGINE_INTERFACES.md`, link_temporal).
- The stale-relationship sweep itself refuses on Rust (it runs in `maintenanceTransaction`).
- `readProjectionReadinessGeneration` is the store's commit sequence. Any commit advances it, so the cached probe answer
  is dropped after a write the SQL engines' generation ignores. Inside a transaction it is null, as the SQL answer is while
  a transaction is in flight: the transaction reads its own writes, which the sequence does not count until it commits.
  A cached answer is never stale.
- `projectionRebuildProgress` is null unless a `protocol_activation` job waits on a `text` page (a live source, and not an
  image unless the page is a segmented shell) in the scope, as the SQL's `started` does (#10000); the clock starts at the
  oldest such job. No store writer queues `protocol_activation` yet (an upgrade's activation runs only on the SQL
  engines), so on a store it is null in practice.
- A coverage read applies `pageEligibleSql`'s trust part: `minTrust` drops a page whose stamped tier ranks below the
  floor (a stored `null` counts as `unknown`; a name that is no tier refuses with `invalid_argument`), and
  `suppressFlagged` drops a page at or below `agent_written` with an instruction-family flag receipt
  (`trust::activation_suppressed`, as `readPageTrustRows` computes `flagged`). `requireSafeChunks` changes nothing, because these reads count pages, not chunks.
- A relevance pattern that is not the `(^|[^[:alnum:]])<word>([^[:alnum:]]|$)` shape `coverageRelevance` builds refuses
  (`health`): the store runs no POSIX regex.
- A pending count that reaches its cap of 1000 refuses (`health`). The SQL engines' `LIMIT` takes 1000 rows in no fixed
  order, so `could_affect` of a capped count depends on the scan order: PGLite and Postgres can give different answers
  for the same pages, and no store order matches both. A search on a brain with 1000 or more waiting pages in scope
  stops on this refusal.
- The store does not tell an image page that a seal fixes (`sealable`) from one a re-import fixes (`reimport`): both
  count as `could_affect_images`, as on the SQL engines.
- `gbrain reindex-search-vector` for a language other than `english` refuses (`keyword_search`): see "The keyword
  index rebuild is a no-op".
- The store has no `graph_generation_seq`: a relationship write does not bump a graph generation.
- `lineGrammar` publication checks the generation config value but takes no `FOR SHARE` lock: the store's write
  transaction is serial.
- `edgeValidityCounts` reports counts on every store (the SQL arm returns null when the tables are absent, which never
  happens on a store), and `proposals` is always zero: the store keeps no `link_edge_proposals` rows.
- The `temporal` read option of a link read (`LinkReadScope.temporal`) still refuses (`links`): the store reads link
  rows as they are, with no point-in-time view. See [link_queries.md](link_queries.md), "Refusals".
