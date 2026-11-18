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

## Rules

- `scope` is `all` or `world`, `semantics` is `state` or `event`, a transition `kind` is `start` or `end`, a precision is
  `day`, `month` or `year`. Any other value is refused with `constraint_violation` (the tables' CHECKs).
- `valid_ranges` is stored and returned in the text form Postgres prints for a `datemultirange` (`{[2019-02-01,2025-03-01)}`).
- The privacy policy of the world scope (`originPolicy`, `excludePrivate`) uses the store's page privacy rules
  (`facts::page_hidden`), the same rules `privatePagesFilterFragment` composes in SQL.
- A repeated refresh over unchanged evidence writes nothing and returns 0.
- `applyLinkTemporalRows` replaces the origin's derived transitions: the old rows go before the new rows are written. On
  Postgres the SQL statements are pipelined, which keeps their order only on one connection, so the Postgres member opens a
  transaction when its caller has none (`test/e2e/link-temporal-apply-order-postgres.test.ts`).

## The call sites and what they run on the Rust engine

| Site | Members | Rust |
| --- | --- | --- |
| `link-relationships.ts` | readLinkRelationshipEvidence, writeLinkRelationshipState, linkRelationshipKeysForPages, staleLinkRelationshipKeys | equal |
| `link-temporal-apply.ts` | linkRelationshipKeysForOrigin, applyLinkTemporalRows, writeManualLinkTransitions, removeManualLinkTransitions | equal |
| `link-relationship-notes.ts` | listRelationshipNoteRows | equal |
| `doctor/checks/edge-validity.ts` | edgeValidityCounts | equal |
| `mentions/referrers.ts` | listPageStatusByRef, listRecordMetadataRows | equal |
| `search/retrieval-coverage.ts` | countEmbeddingHeldPages | equal (always 0: the store keeps no embedding budget rows) |
| `search/retrieval-coverage.ts` | countPendingProjectionPages, projectionRebuildProgress | typed refusal (`health`) |
| `commands/reindex-search-vector.ts` | countSearchVectorRows, replaceSearchVectorTriggerFunction, backfillSearchVectors, ensureFactsKeywordIndex | equal JSON (a no-op under `english`) |

Pinned by `test/engine-parity/link-temporal.test.ts` on every arm.

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
  `staleLinkRelationshipKeys` sweep finds them.
- The stale-relationship sweep itself refuses on Rust (it runs in `maintenanceTransaction`).
- `countPendingProjectionPages` and `projectionRebuildProgress` refuse. Search reaches them only after
  `probeProjectionReadiness`, which reads through `executeRaw` and so also refuses or reports unknown on Rust.
- The store has no `graph_generation_seq`: a relationship write does not bump a graph generation.
- `lineGrammar` publication checks the generation config value but takes no `FOR SHARE` lock: the store's write
  transaction is serial.
- `edgeValidityCounts` reports counts on every store (the SQL arm returns null when the tables are absent, which never
  happens on a store), and `proposals` is always zero: the store keeps no `link_edge_proposals` rows.
