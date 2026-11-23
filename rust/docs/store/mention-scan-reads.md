# The brain store: the stale-mention scan's reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`scanStaleMentions` (`src/core/by-mention.ts`) compares each scanned page's stored `mentions` links with what the current
gazetteer would produce. It read the scanned pages and their links through `executeRaw`; PGLite and Postgres run the same
SQL, now in `src/core/engine-sql/cycle-reads.ts`. The store answers from its page and link records
(`crates/gbrain-store/src/mention_scan_reads.rs`) and has no keys of its own. The TypeScript members are in
`src/core/rust-engine/store-members/cycle-reads.ts`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listStaleMentionPages(limit)` | `[{ id, slug, source_id, title, body_storage, body }]` | `listStaleMentionPages` |
| `brain.listStaleMentionLinks(limit)` | `[{ from_id, from_slug, to_slug, to_source_id, link_kind, link_type }]` | `listStaleMentionLinks` |

## What each member answers

| Member | Notes |
| --- | --- |
| `listStaleMentionPages` | The first `limit` live pages with at least one outgoing `mentions` link, ordered by slug bytes then page id (two sources may hold one slug, so the id breaks the tie at the lowest page id). `body` is the title, compiled truth and timeline joined by blank lines; a segmented page's empty body columns read as empty text and `body_storage` is `segmented`. |
| `listStaleMentionLinks` | The `mentions` links of those same pages, by from-slug then to-slug bytes. A link whose target page is gone is not listed, as the SQL join drops it. |
