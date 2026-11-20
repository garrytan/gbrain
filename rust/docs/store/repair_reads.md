# The brain store: Repair scans that order by byte

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These scans were statements `gbrain repair` ran through `executeRaw`, each ordered by byte (`COLLATE "C"`) so a repair preview
lists its items, and its item cursors point, in the same order on every engine whatever the database locale is. The
TypeScript statements are in `src/core/engine-sql/collate-repair-reads.ts`; the store module is
`rust/crates/gbrain-store/src/repair_reads.rs`.

Keys: this module adds none. The alias scans read the alias rows ([aliases.md](aliases.md), `aliases::alias_target_rows`) and look
each row's page up by `(source, slug)`; the fact scans read a source's fact rows ([facts.md](facts.md)). Text compares in byte
order, as a Rust `String` does. Source ids holding a NUL byte are `invalid_argument`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.countOrphanedAliasRows()` | `{source_id, slug_redirects, page_aliases}` per source, counting the `slug_aliases` rows whose `canonical_slug` and the `page_aliases` rows whose `slug` has no page row (a soft-deleted page is a row) in the source; by source id in byte order. A source with none is left out | `ORPHANED_ALIAS_COUNTS_SQL` |
| `brain.listOrphanedAliasTargets(sourceIds)` | `{source_id, slug, page_aliases, slug_redirects}` per `(source, target slug)` of those sources with an alias row and no page row; by source id, then slug, in byte order | `aliasesRepair.plan` |
| `brain.countSoftDeletedAliasTargets(sourceIds)` | how many alias rows of those sources (both tables) name a soft-deleted page | `aliasesRepair.plan` |
| `brain.listDuplicateFactRows(sourceIds, auditSources)` | the unexpired, unsuperseded, not-lapsed facts of those sources whose `source` is not an audit source and that share a source, visibility, speaker (`attributed_to`, empty when none) and fingerprint with at least one other: `{id, source_id, visibility, fp, fact, entity_slug, row_num, source_markdown_slug, fenced, speaker}`; by source, visibility, fingerprint and speaker in byte order, the fenced copies first, then oldest first, then id | `findDuplicateFacts` |
| `brain.listPagelessEntityFacts(sourceIds)` | `{source_id, slug, ids, fenced}` per `entity_slug` of those sources with no live page: `ids` the facts with no fence row in id order (null when none), `fenced` how many have one; by source, then slug, in byte order | `classifyPagelessEntities` |
| `brain.listSourceIncarnations(sourceIds)` | `{id, incarnation}` of each named source that exists, in id byte order | the repair preview hash |
| `brain.listClosedConsolidationTies(sourceIds)` | `{source_id, id, entity_slug, take_id, valid_from, partners}` for each unexpired fact consolidated into a take, with a claim metric and an entity, whose `valid_until` is its `valid_from`; `partners` the other facts of the source consolidated into the same take with the same metric, unit, period and `valid_from` in id order (null when none); `valid_from` as `timestamptz::text` in UTC (`2026-01-01 00:00:00+00`); by source in byte order, then id | `findClosedTies` |
