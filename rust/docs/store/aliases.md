# The brain store: Slug renames and aliases

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

This family moves a page to a new slug, keeps the old slug as an alias of the new one, keeps the
alias names a page answers to, and keeps a page's contextual retrieval state. In PGLite these are
the `slug_aliases` and `page_aliases` tables and the `pages.contextual_retrieval_mode` and
`pages.corpus_generation` columns. The key tag is the reserved `k`. These records were part of format 1 and
changed no format number; the store is at format 7 now ([format.md](format.md)). Text
parts of a key are joined with a `0x00` byte.

| Key | Value | Mirrors |
| --- | --- | --- |
| `k 0x01 source \0 alias_slug` | `{ canonical_slug, notes? }` (JSON) | one `slug_aliases` row, unique on `(source_id, alias_slug)` |
| `k 0x05 source \0 canonical_slug \0 alias_slug` | empty | index: the aliases a rename repoints |
| `k 0x02 source \0 alias_norm \0 slug \0 origin` | empty | one `page_aliases` row, unique on `(source_id, alias_norm, slug, origin)` |
| `k 0x03 source \0 slug \0 alias_norm \0 origin` | empty for a `frontmatter` row; `{ c, t? }` (JSON: `case_sensitive`, `alias_text`) for a `declared` or `subject` row | index: the alias rows of one page, and the columns of a derived row the key does not hold |
| `k 0x04 page_id` | `{ mode, corpus_generation? }` (JSON) | `pages.contextual_retrieval_mode`, `pages.corpus_generation`; no record is both `NULL` |
| `k 0x06 source \0 old_slug \0 new_slug` | empty | one `slug_rename_history` row, unique on `(source_id, old_slug, new_slug)` (migration v285); `created_at` is not kept |

The alias rows are keyed by `(source, slug)`, not by page id as the sketch in
`docs/designs/RUST_ENGINE_INTERFACES.md` has it. Neither PGLite table has a foreign key to `pages`,
so a row outlives a hard delete of its page and answers again for a page created later at the same
slug; a page id key would lose that. `slug_rename_history` has no foreign key to `pages` either, and
PGLite's single `deletePage` is a plain `DELETE FROM pages`, so a rename row outlives it too.

The batch purges (`deletePages`, `purgeDeletedPages`) differ: in their transaction, after the pages
are gone, PGLite runs `scrubPurgedSlugStores` (src/core/engine-sql/pages.ts:237 and :397). Its
`SLUG_STORES` list (src/core/persistence/purge-slug-stores.ts:6) names three stores of this family,
in this order: `page_aliases` by `slug`, `slug_aliases` by `canonical_slug` and
`slug_rename_history` by `new_slug`. `scrub_purged_slug_stores` deletes the same rows in the same
order, called from `page_ops::scrub_purged_slugs`; its last step is `scrub_purged_rename_history`. An alias spelled like a purged slug that names
another page, and a rename row from a purged slug to another page, stay.

A page deleted for good (`cascade::remove_page_rows`) loses
only its contextual retrieval state, which is a column of the page row. `getPage` shows
`contextual_retrieval_mode` through the family's `page_columns` hook when the page has a state, and
`null` (`PAGE_ROW_DEFAULTS`) when it has none. The state is keyed by page id, so it survives
`putPage`, a soft delete and a rename, as the columns do in PGLite.

A deleted source loses every alias row of that source, as Postgres's `ON DELETE CASCADE` does:
`remove_source_rows` (on core's `cascade::remove_source_rows` list) deletes the source's `k 0x01`,
`0x02`, `0x03`, `0x05` and `0x06` keys and the state of any page still in it. The source delete
(`deleteSourceRecord`, rust/docs/store/sources.md) calls it.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.updateSlug(oldSlug, newSlug, sourceId?)` | the number of pages moved, 0 or 1. The page at `(sourceId ?? 'default', oldSlug)`, soft-deleted or not, is versioned as it stood, moved by `pages::rename_page` (same id, new knowledge revision, cleared text projection revision, new `updated_at`), then its old slug becomes an alias of the new one and its alias rows move with it. `invalid_slug` for a bad new slug and `constraint_violation` for a taken one; either keeps nothing. A segmented page is versioned as a reference to its live body generation (as `createVersion`), so its body never moves. A NULL body with no segmented generation behind it (a row PGLite's CHECK forbids) answers `invalid_state` before anything is written, and the member refuses it as `engine_capability_missing`. Moving a page onto its own slug changes only `updated_at` | `updateSlug` |
| `brain.resolveSlugWithAliasDetailed(slug, sources)` | `{ canonical_slug, source_id, matches }` from the first source in `sources` that has `slug` as an alias, or `null`. The TypeScript member warns once per process when `matches > 1` and returns `canonical_slug` (or `slug`) for `resolveSlugWithAlias` | `resolveSlugWithAliasDetailed`, `resolveSlugWithAlias` |
| `brain.listSlugAliases(sourceId)` | `[{ alias_slug, canonical_slug }]`: every `k 0x01` row of the source, in alias byte order (the SQL has no `ORDER BY`; link extraction builds a map from it). A source id with a NUL byte names no row. The TypeScript member is in `store-members/alias-fanout-reads.ts`, beside its SQL | `listSlugAliases` |
| `brain.resolveAliases(aliasNorms, { sourceId?, sourceIds?, excludePrivate?, minTrust?, suppressFlagged? }?)` | `[aliasNorm, [{ slug, source_id }]]` pairs in alias byte order, pages by source then slug, for aliases that name a live page (not soft deleted, not quarantined, source not archived) in the scope. `excludePrivate` is the page policy (`page_hidden`), the caller's reader identity and private-readable grant included, `minTrust` and `suppressFlagged` the trust floor and flagged-page filter over the page's stored tier and write-gate receipts; a page they drop names nothing. Within one source only the best origin of the remaining rows answers (frontmatter, then declared, then subject), and a derived alias yields to another live page the same scope may read whose lower-cased title is the alias. A tier name that is no tier refuses with `invalid_argument`. The TypeScript member builds the `Map` | `resolveAliases` |
| `brain.aliasCanonicalRefs({ refs, source_ids, live, exclude_private })` | `[{ source_id, canonical_slug }]` for each distinct ref that is the canonical slug of a `slug_aliases` row (one `k 0x05` prefix scan per ref) and whose page row exists, in byte order by source then slug (the SQL has no `ORDER BY`). With `live` (the TypeScript member sets it when a policy was passed, as `pageReadFilter('p', policy, !!policy)` does) the page must be live: not soft deleted, not quarantined, its source present and not archived; without it a soft-deleted page still answers. `source_ids` keeps the named sources. `exclude_private` applies the page policy of `facts/privacy.rs` (`page_hidden`), a caller's reader identity and private-readable grant included. The TypeScript member reads `sourceIds`, else `sourceId`, and `excludePrivate` through `storePagePolicy` (with `callerReaders`); `minTrust` and `suppressFlagged` apply `trust::TrustPolicy` to the canonical page's stamped tier and its write-gate receipts, as `pageReadFilter` does; it ignores the other search options the SQL does not read | `aliasCanonicalRefs` |
| `brain.setPageAliases(slug, sourceId, aliasNorms)` | nothing. Replaces the page's `frontmatter` rows with the non-empty, distinct names; rows of other origins stay. The page need not exist; the source must when there is a row to insert (`source_not_found`) | `setPageAliases` |
| `brain.replaceDerivedAliases(slug, sourceId, aliases)` | nothing. Deletes the page's `declared` and `subject` rows, then inserts `aliases` (`[{ alias_norm, origin, case_sensitive, alias_text }]`) in order; a row whose `(alias_norm, origin)` the page already holds is skipped (`ON CONFLICT DO NOTHING`), so the first of two equal rows wins and a `frontmatter` row keeps its own columns. An origin other than `frontmatter`, `declared` or `subject` is `constraint_violation` with Postgres's check-constraint text; a missing source is `source_not_found` when there is a row to insert. A refusal writes nothing | `replaceDerivedAliases` |
| `brain.updatePageContextualRetrievalState(slug, sourceId, mode, corpusGeneration)` | nothing. Stamps the live page at `(sourceId, slug)` and sets its `updated_at`; a missing or soft-deleted page is left alone. The knowledge revision does not move. Moving from `title` or `per_chunk_synopsis` to `none` drops the page's `embedding_signature` and its chunk vectors (stamped pending now), unless the page is `embed_skip` | `updatePageContextualRetrievalState` |

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

- `setPageAliases` writes the `frontmatter` rows and `replaceDerivedAliases` the `declared` and
  `subject` rows of the mention pass. A rename carries a derived row's `{ c, t }` value to the new
  slug. The store keeps `alias_text` and `case_sensitive` on that value, and the alias fan-out
  reads `resolveCaseSensitiveAliases` and `readPageAliasRows` return them
  ([alias_fanout_reads.md](alias_fanout_reads.md)).
- `replaceDerivedAliases` refused writes nothing on every engine: PGLite and Postgres open a
  transaction for a caller outside one, so a failed INSERT also undoes the DELETE. A `frontmatter`
  row it is sent is stored as `setPageAliases` stores one, not case-sensitive and with no text.
- A rename calls core's `cascade::rename_slug_rows` for the records other families key by slug
  (PGLite `moveSlugBindings` steps 1-6: fact withdrawals, `facts.entity_slug`,
  `facts.source_markdown_slug`). The facts entry is `facts::rename_slug_rows`: it moves the fact
  withdrawals first (through `trust::withdrawals::move_subject_in`), then `facts.entity_slug` and
  `facts.source_markdown_slug`.
- `putPage` with `contextualRetrieval` writes the state through `aliases::stamp_contextual_retrieval`;
  a `none` mode writes nothing.
- The version a rename writes has no change reason (`pages::snapshot_in` writes none).
- The `constraint_violation` message for a taken slug is `pages::rename_page`'s, not Postgres's
  unique-violation text.
- Text that holds a NUL byte is refused `invalid_argument` on write and finds nothing on read.
- On the other alias reads `excludePrivate`, `minTrust` and `suppressFlagged` refuse with
  `engine_capability_missing`. `requireSafeChunks` and `inline` change nothing.

`crates/gbrain-store/tests/aliases.rs` covers what the parity cases in
`test/engine-parity/sync-aliases.test.ts` cannot show: state across a reopen, the hard-delete
rules, the rename's alias bookkeeping, the visibility, trust and privacy filters of `resolveAliases`, the live and
privacy filters of `aliasCanonicalRefs` and the refused inputs; the shadow rule for a private title
is tested there too. `aliasCanonicalRefs` and `resolveAliases` under `excludePrivate` have parity cases in
`test/engine-parity/search-reads.test.ts`. The trust and privacy scope of `resolveAliases`, with the search
alias fan-out that reads it and the byte order of the aliases and their pages (which `readAliases` pins
with `COLLATE "C"`), has parity cases in `test/engine-parity/alias-trust.test.ts`.
