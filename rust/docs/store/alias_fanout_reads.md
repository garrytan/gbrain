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

The by-alias key is empty. The by-page key of a derived row (origin `declared` or `subject`, written by
`replaceDerivedAliases`) holds its `{ c, t? }` value (`case_sensitive`, `alias_text`); the by-page key of a
`frontmatter` row is empty, which reads as the column defaults (`case_sensitive` false, `alias_text` NULL), as PGLite's
`setPageAliases` writes them. Unit tests write rows through `Store::set_page_aliases` and
`Store::replace_derived_aliases` and read them back here, so a layout change in `aliases.rs` fails them. A row this
reader does not know refuses with `store_corrupt`, and the read does not drop what the row holds: a by-alias key with a
value, a by-page value that is not `{ c, t? }`, or a by-alias key with no by-page key. The title read finds its pages by the keyed title entries
([keyed-index.md](keyed-index.md)) and reads their records ([pages.md](pages.md)).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.findPagesByTitles({ title_norms, source_ids, types, exclude_private })` | `{ slug, source_id, t }` rows, by source then slug in byte order: the pages of a listed source that are not soft-deleted, whose type is listed and whose lower-cased title (`t`) is a listed title. `exclude_private` is the page policy of `excludePrivate` (`page_hidden`, [facts.md](facts.md)); null keeps every page. Quarantined pages and archived sources still answer, as the SQL does not filter them | `findPagesByTitles` |
| `brain.resolveCaseSensitiveAliases(aliasNorms, sourceIds)` | `{ slug, alias_norm, alias_text }` rows of each listed alias in each listed source whose `case_sensitive` is true, by source, slug, alias in byte order. The read scans the by-alias keys and reads each row's value from its by-page key. One alias under two origins (`declared` and `subject`) answers twice, as the SQL has no `DISTINCT`; the SQL leaves the order of those two open, and the store puts them in origin byte order. A `frontmatter` row is never case-sensitive | `resolveCaseSensitiveAliases` |
| `brain.readPageTitle(sourceId, slug)` | the title of the page at `(sourceId, slug)`, soft-deleted pages included; null with no page | `readPageTitle` |
| `brain.readPageAliasRows(sourceIds, slugs)` | `{ slug, source_id, alias_norm, alias_text, origin }` rows of each listed slug in each listed source, by source, slug, alias, then origin in byte order. `alias_text` is the derived row's text, or null for a `frontmatter` row. A listed slug twice reads once | `readPageAliasRows` |

Text that holds a NUL byte is `invalid_argument` in every member, as Postgres refuses a NUL in a text parameter. The
TypeScript members return `[]` with no call when a list is empty, as the SQL members do.

The TypeScript `findPagesByTitles` member passes `excludePrivate` through `storePagePolicy`
(`src/core/rust-engine/store-members/private-provenance.ts`). A caller whose record holds a reader identity and a
private-readable grant, the folder rules it satisfies and the pending prefixes its record holds is served: the store
reads them from the policy (`facts/privacy.rs`). Modelled labelled-only and member-lineage page policies are also served when their SQL text matches a fresh
reference record. A caller whose text matches none of the supported references, including a labelled-only audience
of several identities, gets the typed `engine_capability_missing` refusal. The caller in `alias-fanout.ts` keeps master's
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

None in this family.
