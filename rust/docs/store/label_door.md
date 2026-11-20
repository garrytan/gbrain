# The brain store: the label door

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`delete_page` carries a private origin's privacy to the pages derived from it (src/core/repair/origin-carry.ts), and
the label door writes `visibility: private` onto those pages (src/core/repair/label-write.ts and
src/core/trust/page-write.ts). PGLite and Postgres ran these reads through `executeRaw`. The SQL now lives in
`src/core/engine-sql/label-door.ts`. The store answers from its page, link, alias, rename and source records
(`crates/gbrain-store/src/label_door.rs`). The one new key is the label guard, `t 0x0A page_id`
([trust.md](trust.md) "Label guards").

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readPrivacyOrigin(sourceId, slug, honorAliases)` | `{ id, deleted }` of the page (live or soft-deleted) when it is an atom or the privacy rules hide it; `null` otherwise | `SELECT id, deleted_at IS NOT NULL … WHERE (type = 'atom' OR NOT privacyPartSql('p'))` |
| `brain.listOriginDependents(origins, honorAliases)` | `[{ id, cleared_id, source_id, slug, deleted }]`: each same-source page the privacy rules hide now and would not once the origin rows are gone, with the origin it is tied to, by (id, cleared_id) | private-labels.ts `dependentsSql('remove')` |
| `brain.listCheckoutFiles(pageIds)` | `[{ id, source_id, source_path, local_path }]`: each listed page with a recorded file, with its source's checkout (`null` when the source has none), by id, once each; an unknown id answers nothing | `SELECT p.id, … FROM pages p JOIN sources s … WHERE p.id = ANY($1)` |
| `brain.readPageLabelRow(sourceId, slug)` | `{ id, frontmatter }` of the page (live or soft-deleted); `null` for a missing page | `SELECT id, frontmatter FROM pages WHERE source_id = $1 AND slug = $2` |
| `brain.writePageLabelGuard(pageId, tier)` | `undefined`. A tier sets the guard, stamped now; `null` deletes it. An unknown page refuses `constraint_violation`, as the foreign key does | `INSERT … ON CONFLICT (page_id) DO UPDATE` / `DELETE FROM page_label_guards WHERE page_id = $1` |

The privacy rules are `facts/privacy.rs` `privacy_allows`, the store's form of `privacyPartSql`. The SQL dependents
query finds the pages that can name a cleared page through a jsonpath probe and keeps only exact references. So a
full read of the cleared sources' pages returns the same rows. The query's postimage (the pages table without the
cleared rows, and so without the links to them) is the `Without` read, which hides the cleared pages' keys.

## TypeScript members

`src/core/rust-engine/store-members/label-door.ts` answers the five BrainEngine members on a Rust brain.

- `honorAliases` is read off the rendered snapshot filter (`privateSnapshotFilterFragment('h')` includes
  `privacyAliasSql('h')`). That is the one process setting `privacyPartSql` reads, so both engines judge by the same
  setting.
- The origins of `listOriginDependents` map to `{ id, sourceId, slug }` (the store refuses unknown fields).

## What still refuses

- `delete_page --purge` parks and purges through raw SQL (repair/origin-carry.ts, persistence/page-purge.ts). On the
  Rust engine it refuses `engine_capability_missing` (`raw_sql`) before any write, and the page stays live.
- The label guard's readers (`labelGuardTier`, the deletion and graduation inventories) read through `executeRaw`.
