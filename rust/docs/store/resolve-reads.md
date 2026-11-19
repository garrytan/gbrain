# The brain store: entity resolver page reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the page reads the entity resolver (`src/core/entities/resolve.ts`) ran through `executeRaw`. PGLite and
Postgres run the SQL in `src/core/engine-sql/entity-reads.ts`, with the text the resolver sent. The store answers from
its page records (`crates/gbrain-store/src/cli_reads/resolve_reads.rs`) and has no keys of its own.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readLiveSlugs(sourceId, slugs, limit)` | the slugs among `slugs` at which a live page of the source sits, retired or not, each once, in list order (the SQL sets none); a `limit` stops at that many | `readLiveSlugs` |
| `brain.readLivePageTypes(sourceId, slugs, policy)` | `{ slug, type }` for each live page of the source among `slugs`, retired or not, that the page policy (when given) does not hide, each once, in list order | `readLivePageTypes` |

## Rules the store keeps from the SQL

- **Soft delete.** Every read answers live pages only (`deleted_at IS NULL`).
- **Source.** Every read takes one source.
- **Privacy.** `readLivePageTypes` takes the page policy of `facts/privacy.rs` that the TypeScript side derives from the
  resolver privacy; a read floor it cannot map to a store policy refuses typed before the call.
- **Each page once.** `slug = ANY(...)` is a filter, so a slug listed twice answers once.
