# The brain store: identity-downgrade record reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`recordIdentityDowngrades` (a sync that renames a file records what the old page held) ran four statements through
`executeRaw`: the soft-deleted page the file once backed, the live pages at its new path, what a carry would move, and the
checkpoint row that keeps the record. PGLite and Postgres run the same SQL, now in `src/core/engine-sql/cycle-reads.ts`.
The store answers the three page reads from its page, fact, link and alias records
(`crates/gbrain-store/src/identity_downgrades.rs`) and has no keys of its own; the record itself is written with
`writeOpCheckpointRecord` (the checkpoint members of [persistence.md](persistence.md)). The TypeScript members are in
`src/core/rust-engine/store-members/cycle-reads.ts`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readSoftDeletedPageAtOrigin(sourceId, path, slug)` | `{ id, slug, deleted_at }` or `null` | `readSoftDeletedPageAtOrigin` |
| `brain.listLivePagesAtOrigin(sourceId, sourcePath)` | `[{ id, slug }]` by slug bytes | `listLivePagesAtOrigin` |
| `brain.countPageCarryRows(sourceId, slug, pageId)` | `{ facts, links, aliases }` | `countPageCarryRows` |

## What each member answers

| Member | Notes |
| --- | --- |
| `readSoftDeletedPageAtOrigin` | A soft-deleted page whose `source_path` is `path`, or that has no path and the slug `slug`: the latest `deleted_at` first, the lowest id among equal deletions. `deleted_at` is the `timestamptz::text` form (`2026-01-01 00:00:00+00`). |
| `listLivePagesAtOrigin` | Live pages whose `source_path` is `sourcePath`, by slug byte (`ORDER BY slug COLLATE "C"`). The caller used the page-origin guard's `canonicalOriginPage`, whose read ordered by the database's locale; `pickCanonicalOrigin` sorts the ambiguous slugs itself, so the typed member changes no answer and every engine names the same canonical page. |
| `countPageCarryRows` | Facts about the slug in the source, links of the page at either end (a link between the page and itself counts once), and the slug's aliases. |
