# The brain store: Alias fan-out reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Search's alias fan-out (`src/core/search/alias-fanout.ts`) resolves the entity a query names and then searches every
other name that entity goes by. These four reads feed it: the exact-title lookup and the case-sensitive alias read of
`resolveQueryEntities`, and the page title and alias rows that `namesOf` reads. The TypeScript statements are in
`src/core/engine-sql/alias-fanout-reads.ts`; the store module is `rust/crates/gbrain-store/src/alias_fanout_reads.rs`.

Keys: the alias reads scan the `page_aliases` rows the aliases family writes ([aliases.md](aliases.md),
`aliases.rs`). This module adds no key and no tag. It mirrors two layouts that are private to `aliases.rs`:

- `k 0x02 <source> 0x00 <alias_norm> 0x00 <slug> 0x00 <origin>` (by alias), and
- `k 0x03 <source> 0x00 <slug> 0x00 <alias_norm> 0x00 <origin>` (by page),

both with an empty value. A unit test writes rows through `Store::set_page_aliases` and reads them back here, so a
layout change in `aliases.rs` fails that test. A row whose value is not empty comes from a writer this reader does not
know: the read refuses with `store_corrupt` and does not drop what the row holds. The title read walks the page
records ([pages.md](pages.md)).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.findPagesByTitles({ title_norms, source_ids, types, exclude_private })` | `{ slug, source_id, t }` rows, by source then slug in byte order: the pages of a listed source that are not soft-deleted, whose type is listed and whose lower-cased title (`t`) is a listed title. `exclude_private` is the page policy of `excludePrivate` (`page_hidden`, [facts.md](facts.md)); null keeps every page. Quarantined pages and archived sources still answer, as the SQL does not filter them | `findPagesByTitles` |
| `brain.resolveCaseSensitiveAliases(aliasNorms, sourceIds)` | `[]`. The store keeps no case-sensitive alias row (see below). The read still scans the rows of each listed source and alias, so a foreign row refuses | `resolveCaseSensitiveAliases` |
| `brain.readPageTitle(sourceId, slug)` | the title of the page at `(sourceId, slug)`, soft-deleted pages included; null with no page | `readPageTitle` |
| `brain.readPageAliasRows(sourceIds, slugs)` | `{ slug, source_id, alias_norm, alias_text: null, origin }` rows of each listed slug in each listed source, by source, slug, alias, then origin in byte order. A listed slug twice reads once | `readPageAliasRows` |

Text that holds a NUL byte is `invalid_argument` in every member, as Postgres refuses a NUL in a text parameter. The
TypeScript members return `[]` with no call when a list is empty, as the SQL members do.

The TypeScript `findPagesByTitles` member passes `excludePrivate` through `storePagePolicy`
(`src/core/rust-engine/store-members/private-provenance.ts`). A caller whose member pages, grants or lineage widen
the page policy gets the typed `engine_capability_missing` refusal. The caller in `alias-fanout.ts` keeps master's
`.catch(() => [])`, so that caller reads the refusal as no title hit, as it read a refused raw statement before.

Differences from PGLite:

- Order: the SQL members sort with `ORDER BY ... COLLATE "C"`, so PGLite, Postgres and the store answer in the same
  byte order. On master the three list reads had no `ORDER BY`. The caller takes the first title hit of a group as
  its lead page and keeps the first alias row of equal rank, so a fixed order fixes an answer that master left to the
  query plan.
- `t` and the title match use Rust `to_lowercase`; Postgres uses `lower()` under the database collation. The two agree
  on ASCII and on the usual letters of other scripts; a few special cases (for example a final sigma or a dotted
  capital I under some locales) can differ. `resolveAliases` and the derived-alias title check use the same rule.

## Known gaps

- The store keeps no `alias_text` and no `case_sensitive` flag. Only `setPageAliases` writes alias rows, every one
  with origin `frontmatter`; PGLite's `setPageAliases` also leaves `alias_text` NULL and `case_sensitive` false, so
  these rows read the same on every arm. The derived rows (origin `declared` or `subject`, with alias text and
  sometimes case-sensitive) come from `replaceDerivedAliases` and the mention pass, which the store refuses. On a
  store brain, `resolveCaseSensitiveAliases` therefore finds nothing and every alias row has a null `alias_text`.
  Serving `replaceDerivedAliases` needs a value or key change in `aliases.rs` and a matching change here.
