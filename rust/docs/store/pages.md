# The brain store: Pages

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Pages are keyed `(source_id, slug)`; `sourceId` defaults to `default`, and a source that does not
exist rejects `source_not_found`. Slugs go through PGLite's `validateSlug` (`invalid_slug`) and are
lower-cased. A `Page` is PGLite's `Page` plus `page_kind`; every date (`created_at`, `updated_at`,
`updated_at_iso`, `deleted_at`, `effective_date`, `ingested_at`) is an ISO string with microseconds
(`2026-08-10T12:00:00.000123Z`) or `null`, and the TypeScript wrapper turns them into `Date`.
A page's `knowledge_revision` is a UUID that changes when its type, kind, title, body, timeline,
frontmatter, deletion or tags change. `text_projection_revision` is `null` until chunks are
installed for that revision. `listPages` and `resolveSlugs` scan every page; there are no
secondary indexes yet.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readPageSnapshot(slug, { sourceId?, sourceIds?, includeDeleted? }?)` | `{ page, tags, revision, sourceIncarnation, withdrawals: [] }` or `null`. `sourceIds` wins over `sourceId`; with neither, the first match, `default` first | `readPageSnapshot` |
| `brain.putPage(slug, page, { sourceId?, allowEmptyOverwrite?, expectedRevision?, force?, chunks?, index? }?)` | the stored `Page`. By default the store also installs chunks and seals the page (see "Chunks and keyword search"); `index: false` writes the page alone, which is what the TypeScript engine always passes, as PGLite's `putPage` writes no chunks | `putPage` |
| `brain.listPages(filters?)` | `Page[]` (default `limit` 100). Filters: `type`, `tag`, `updated_after`, `updatedAfterKeyset { updatedAt, slug }`, `slugPrefix` (literal), `excludeSlugPrefixes`, `slugAfter`, `sourceId`, `sourceIds`, `includeDeleted`, `sort` (`updated_desc` default, `updated_asc`, `created_desc`, `slug`) | `listPages` |
| `brain.countPages({ sourceId? }?)` | number of live pages | `countPages` |
| `brain.lockPageKeys([{ sourceId, slug }])` | `null`. One process owns the brain and one write runs at a time, so keys are already held; it checks the keys are well formed | `lockPageKeys` |
| `brain.resolveSlugs(partial, { sourceId?, sourceIds? }?)` | `[slug]` for the exact live slug, else `[]`. Exact only: PGLite goes on to a fuzzy title match this store does not have, so `[]` means "no exact match", and the TypeScript engine refuses `engine_capability_missing` instead of returning it | `resolveSlugs` (exact half) |
| `brain.softDeletePage(slug, { sourceId? }?)` | `{ slug }` or `null` | `softDeletePage` |
| `brain.restorePage(slug, { sourceId? }?)` | `boolean` | `restorePage` |
| `brain.deletePage(slug, { sourceId? }?)` | `null`; removes the page and its versions | `deletePage` |
| `brain.getTags(slug, { sourceId?, sourceIds? }?)` | sorted `string[]` | `getTags` |
| `brain.addTag(slug, tag, { sourceId? }?)` | `null`; `page_not_found` for a missing page | `addTag` |
| `brain.removeTag(slug, tag, { sourceId? }?)` | `null`; no error when the page or tag is absent | `removeTag` |
| `brain.createVersion(slug, { sourceId? }?)` | the version row; `page_not_found` for a missing page | `createVersion` |
| `brain.getVersions(slug, { sourceId?, sourceIds?, limit?, includeBody? }?)` | version rows, newest first; `includeBody: false` leaves out `compiled_truth` and `timeline` | `getVersions` |

`putPage` follows PGLite:

- `content_hash` is the caller's, else SHA-256 of the canonical `{ title, type, compiled_truth,
  timeline, frontmatter, tags }` envelope. Two sample pages hash the same as the TypeScript
  `contentHash`; parity for every JSON number and string is not proven, so a caller that needs it
  passes `content_hash`.
- An update clears `deleted_at`, sets `updated_at` and keeps `effective_date`,
  `effective_date_source`, `import_filename`, `source_path`, `source_kind`, `source_uri`,
  `ingested_via` and `ingested_at` when the new write leaves them out.
- A blank `compiled_truth` over a page that has content rejects `empty_overwrite` unless
  `allowEmptyOverwrite`.
- `expectedRevision` is `undefined` (no check), `null` (the page must not exist) or a UUID. A
  mismatch rejects `revision_conflict`; `force: false` with no `expectedRevision` over an existing
  page rejects `revision_required`. `force: true` skips the check and cannot be combined with
  `expectedRevision`. The check sees soft-deleted pages.
- Tags are not part of `putPage`; `addTag` and `removeTag` change them, as in PGLite.

## Nullable page fields

PGLite lets four `pages` columns hold NULL, and the page record holds NULL in the same four (`PageText` and
`PageRecord` in `crates/gbrain-store/src/pages.rs` carry the same contract as doc comments):

| Field | NULL means | Written as NULL by |
| --- | --- | --- |
| `compiled_truth`, `timeline` | a segmented shell page: its body lives in segment texts. PGLite's `pages_body_storage_chk` makes both NULL exactly when `body_storage = 'segmented'`; an inline page holds a string (`''` when empty) | the page_body family (`createSegmentedPageShell`, a generation flip); never `putPage` |
| `content_hash` | a shell page whose body is not published yet, as `createSegmentedPageShell` leaves it | the page_body family; `putPage` always sets a hash |
| `chunker_version` | the store has not recorded one. `putPage` keeps the stored value and sets none on a new page | the page_body family sets it; not part of the page JSON (PGLite's `rowToPage` leaves it out) |

- The page JSON (`getPage`, `readPageSnapshot`, `listPages`) and version rows send each NULL as `null`. The
  TypeScript codec turns a `null` body into PGLite's segmented page: `compiled_truth` and `timeline` read as `''`
  behind getters that throw `page_body_segmented`. `content_hash` stays `null`.
- Inside the store, a NULL body reads as `''` through `&str`, so inline readers (`auto_chunks`, sizes, text
  matching) see an empty body. Use `is_null` or `as_deref` where NULL and `''` differ; equality never treats them as
  the same, so a writer that moves a page between segmented and inline sees a change.
- A blank `putPage` over a live shell rejects `empty_overwrite` (`(segmented)` in the message) unless
  `allowEmptyOverwrite`, as PGLite does.
- Any other `putPage` over a shell, live or soft-deleted, rejects `constraint_violation` with PGLite's CHECK message
  (`new row for relation "pages" violates check constraint "pages_body_storage_chk"`) and stores nothing. PGLite's
  `ON CONFLICT` update sets the body and keeps `body_storage = 'segmented'`, so its CHECK refuses the row. PGLite
  throws the raw Postgres error (code `23514`); the store uses `constraint_violation` with the same message.
- A version snapshot copies the page's NULLs.
- Format: records written before these fields were nullable hold strings and read unchanged; a record without
  `chunker_version` reads it as NULL, and `chunker_version` is written only when set. `FORMAT_VERSION` stays 1.

## Search timeline

PGLite's page keyword vector (`search_vector`) is the title (weight A) plus the first 65,536 characters of
`sanitizeRemoteBody(timeline)` (weight C). It is set when the page's chunks are sealed (`sealPageTextProjection`).
The sanitizer runs in TypeScript only, so `sealChunks` sends its output with the seal (`searchTimeline` in the
`upsertChunks` options) and the store keeps it with the page under `M page_search_timeline/<page id>`.

- **Record.** `SearchTimeline { revision, timeline }`: the page's `knowledge_revision` at the seal, and the text with
  NUL removed, cut to 65,536 characters (`SEARCH_TIMELINE_MAX_CHARS`).
- **Read.** `pages::search_timeline(read, page_id)` returns the record, or `None` when no seal sent one since the
  last write that set the title or timeline. The text describes the page's current text when `revision` equals the
  page's `text_projection_revision`.
- **Written by** a seal that carries `searchTimeline` (TypeScript `sealChunks`). A segmented page has a NULL timeline
  and sends none. A write that does not seal ignores it, and a seal without it (the store's own indexing `putPage`)
  writes nothing.
- **Forgotten** (`pages::forget_search_timeline`) by every write that sets the title or timeline. PGLite's
  `trg_pages_search_vector` fires `BEFORE INSERT OR UPDATE OF title, timeline` (and `timeline_lead` once that column
  exists) and puts the unsanitized trigger form back; `UPDATE OF` fires on the `SET` list, also when the value is
  unchanged. Only a later seal with the text writes the record again.
- **Deleted** with the page on a hard delete (`remove_page`).

PGLite SQL that sets `title` or `timeline`, and where the store forgets the record:

| PGLite statement | Store write | Forgets the record |
| --- | --- | --- |
| `putPage` (`engine-sql/pages.ts`, `INSERT … ON CONFLICT DO UPDATE SET title, timeline`) | `pages::put_page_in` (`putPage`, and the journal's `submit_page_mutation`) | always, also when nothing changed and with `index: false` |
| `refreshPageBody` (`engine-sql/pages.ts`, `UPDATE pages SET compiled_truth, timeline`) | page_body family `refresh_page_body` | the family calls `forget_search_timeline` |
| the body generation flip (`engine-sql/page-body.ts`, `UPDATE pages SET … timeline = NULL, title, timeline_lead`) | page_body family `flip_body_generation` | the family calls `forget_search_timeline` |
| `createSegmentedPageShell` (`engine-sql/page-body.ts`, `INSERT INTO pages`) | page_body family | nothing to do: a new page id has no record |
| withdrawal materialize (`page-state/materialize.ts`, `UPDATE pages SET compiled_truth, timeline`) | none: it runs through `executeRaw`, which the Rust engine refuses | not served |

Any other write that changes the title or timeline through `pages::write_page` forgets the record there, since a
changed value means PGLite's `SET` list named the column. A write that keeps both values (a seal, a tag change, a soft
delete, a restore, a rename, `revertToVersion`, which sets only `compiled_truth` and `frontmatter`) keeps it.
