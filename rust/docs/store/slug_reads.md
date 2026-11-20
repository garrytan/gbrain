# The brain store: Slug reads that order by byte

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These reads were statements callers ran through `executeRaw`, each ordered by byte (`COLLATE "C"`) so the row a caller takes
first is the same on every engine whatever the database locale is. The TypeScript statements are in
`src/core/engine-sql/collate-slug-reads.ts`; the store module is `rust/crates/gbrain-store/src/slug_reads.rs`.

Keys: this module adds none. Each read scans the page records ([pages.md](pages.md)); text compares in byte order, as a
Rust `String` does.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.resolveLiveSlugByPath(path)` | the slug of the live page (not soft-deleted) whose `source_path` is `path`, across every source; with several (one per source: a source holds one live page per path), the one in the lowest source id by byte. Null when no live page claims the path. Text holding a NUL byte is `invalid_argument` | `resolveLiveSlugByPath` |
| `brain.listUnarchivedSlugSources(slug)` | the ids of the sources that hold a live page at `slug` and are not archived, in byte order, each once. Empty when none does | `listUnarchivedSlugSources` |
| `brain.countLivePageTypes(scope)` | one `{type, n}` row per page type over the live pages of the scope (`{}` for all, `{sourceId}` or `{sourceIds}`), `n` as text, in no fixed order. A page with no type counts under the empty type | `countLivePageTypes` |
| `brain.listTypeOrphanPages({scope, types, limit})` | `{slug, source_id, type}` of the live pages of the scope whose type is empty or in `types`, ordered by source id then slug, both by byte, cut at `limit` | `listTypeOrphanPages` |
| `brain.readExportPageRows(ids)` | `{page, tags}` for each live page whose id is in `ids` (a repeated id answers once, an unknown or soft-deleted one not at all), `page` as `getPage` returns it with its columns and `tags` in byte order. Rows come in id order; callers map them by `page.id` | `readExportPageRows` |
