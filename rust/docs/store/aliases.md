# The brain store: Slug renames and aliases

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

This family moves a page to a new slug, keeps the old slug as an alias of the new one, keeps the
alias names a page answers to, and keeps a page's contextual retrieval state. In PGLite these are
the `slug_aliases` and `page_aliases` tables and the `pages.contextual_retrieval_mode` and
`pages.corpus_generation` columns. The key tag is the reserved `k`; `FORMAT_VERSION` stays 1. Text
parts of a key are joined with a `0x00` byte.

| Key | Value | Mirrors |
| --- | --- | --- |
| `k 0x01 source \0 alias_slug` | `{ canonical_slug, notes? }` (JSON) | one `slug_aliases` row, unique on `(source_id, alias_slug)` |
| `k 0x05 source \0 canonical_slug \0 alias_slug` | empty | index: the aliases a rename repoints |
| `k 0x02 source \0 alias_norm \0 slug \0 origin` | empty | one `page_aliases` row, unique on `(source_id, alias_norm, slug, origin)` |
| `k 0x03 source \0 slug \0 alias_norm \0 origin` | empty | index: the alias rows of one page |
| `k 0x04 page_id` | `{ mode, corpus_generation? }` (JSON) | `pages.contextual_retrieval_mode`, `pages.corpus_generation`; no record is both `NULL` |
| `k 0x06 source \0 old_slug \0 new_slug` | empty | one `slug_rename_history` row, unique on `(source_id, old_slug, new_slug)` (migration v285); `created_at` is not kept |

The alias rows are keyed by `(source, slug)`, not by page id as the sketch in
`docs/designs/RUST_ENGINE_INTERFACES.md` has it. Neither PGLite table has a foreign key to `pages`,
so a row outlives a hard delete of its page and answers again for a page created later at the same
slug; a page id key would lose that. `slug_rename_history` has no foreign key to `pages` either, and
PGLite's single `deletePage` is a plain `DELETE FROM pages`, so a rename row outlives it too. The
batch purges (`deletePages`, `purgeDeletedPages`) run `scrubPurgedSlugStores`, which drops the rows
that end at a purged slug; `scrub_purged_rename_history` is that step for their Rust caller, which
is not served yet. A page deleted for good (`cascade::remove_page_rows`) loses
only its contextual retrieval state, which is a column of the page row. `getPage` shows
`contextual_retrieval_mode` through the family's `page_columns` hook when the page has a state, and
`null` (`PAGE_ROW_DEFAULTS`) when it has none. The state is keyed by page id, so it survives
`putPage`, a soft delete and a rename, as the columns do in PGLite.

A deleted source loses every alias row of that source, as Postgres's `ON DELETE CASCADE` does:
`remove_source_rows` (on core's `cascade::remove_source_rows` list) deletes the source's `k 0x01`,
`0x02`, `0x03`, `0x05` and `0x06` keys and the state of any page still in it. The Rust engine does not
serve source delete yet, so nothing calls it today.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.updateSlug(oldSlug, newSlug, sourceId?)` | the number of pages moved, 0 or 1. The page at `(sourceId ?? 'default', oldSlug)`, soft-deleted or not, is versioned as it stood, moved by `pages::rename_page` (same id, new knowledge revision, cleared text projection revision, new `updated_at`), then its old slug becomes an alias of the new one and its alias rows move with it. `invalid_slug` for a bad new slug and `constraint_violation` for a taken one; either keeps nothing. Moving a page onto its own slug changes only `updated_at` | `updateSlug` |
| `brain.resolveSlugWithAliasDetailed(slug, sources)` | `{ canonical_slug, source_id, matches }` from the first source in `sources` that has `slug` as an alias, or `null`. The TypeScript member warns once per process when `matches > 1` and returns `canonical_slug` (or `slug`) for `resolveSlugWithAlias` | `resolveSlugWithAliasDetailed`, `resolveSlugWithAlias` |
| `brain.resolveAliases(aliasNorms, { sourceId?, sourceIds? }?)` | `[aliasNorm, [{ slug, source_id }]]` pairs in alias byte order, pages by source then slug, for aliases that name a live page (not soft deleted, not quarantined, source not archived) in the scope. Within one source only the best origin answers (frontmatter, then declared, then subject), and a derived alias yields to another live page whose lower-cased title is the alias. The TypeScript member builds the `Map` | `resolveAliases` |
| `brain.setPageAliases(slug, sourceId, aliasNorms)` | nothing. Replaces the page's `frontmatter` rows with the non-empty, distinct names; rows of other origins stay. The page need not exist; the source must when there is a row to insert (`source_not_found`) | `setPageAliases` |
| `brain.updatePageContextualRetrievalState(slug, sourceId, mode, corpusGeneration)` | nothing. Stamps the live page at `(sourceId, slug)` and sets its `updated_at`; a missing or soft-deleted page is left alone. The knowledge revision does not move | `updatePageContextualRetrievalState` |

A rename first does what PGLite's `recordRenameAlias` does to `slug_rename_history`
(`src/core/page-state/rename-alias.ts`, 29-36), in the same order: it keeps the alias spelled like
the new slug as a history row, deletes a row ending at the old slug that would repeat a row ending
at the new one, moves every row ending at the old slug to the new one, and inserts `old -> new`.
The private-provenance policy (`facts/privacy.rs`) reads these rows through `renamed_to`, as
`gbrain_access_origin_restricted` and `atomMovedOriginPrivateSql` (#8920) do.

Then the rename does what `recordRenameAlias` does to `slug_aliases`: it drops the alias spelled
like the new slug, repoints every alias of the old slug at the new one, and upserts `old -> new`
with notes `rename` (an existing row keeps its notes). Then the old slug's `page_aliases` rows move
to the new slug; a row the new slug already had is kept once. Between the two, the rename calls
`cascade::rename_slug_rows` (PGLite `moveSlugBindings` steps 1-6); the page alias move is steps 7
and 8.

Where this engine differs from PGLite:

- Only `setPageAliases` writes page aliases, so every row has origin `frontmatter`. The `declared`
  and `subject` rows of the mention pass have no typed writer here; `resolveAliases` still ranks
  origins, so a later writer needs no reader change.
- A rename calls core's `cascade::rename_slug_rows` for the records other families key by slug
  (PGLite `moveSlugBindings` steps 1-6: fact withdrawals, `facts.entity_slug`,
  `facts.source_markdown_slug`). The facts entry is a stub until the facts family fills it, so fact
  bindings do not move yet.
- The `none` tier of `updatePageContextualRetrievalState` does not reset `embedding_signature` or
  chunk vectors: this store keeps neither.
- `putPage` with `contextualRetrieval` does not write the state; that option belongs to the page
  family.
- The version a rename writes has no change reason (`pages::snapshot_in` writes none).
- The `constraint_violation` message for a taken slug is `pages::rename_page`'s, not Postgres's
  unique-violation text.
- Text that holds a NUL byte is refused `invalid_argument` on write and finds nothing on read.
- `excludePrivate`, `minTrust` and `suppressFlagged` refuse with `engine_capability_missing`: the
  store keeps no page visibility. `requireSafeChunks` and `inline` change nothing.

`crates/gbrain-store/tests/aliases.rs` covers what the parity cases in
`test/engine-parity/sync-aliases.test.ts` cannot show: state across a reopen, the hard-delete
rules, the rename's alias bookkeeping, the visibility filter of `resolveAliases` and the refused
inputs.
