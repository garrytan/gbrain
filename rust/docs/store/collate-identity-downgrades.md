# The brain store: identity-downgrade record reads and checkpoint value rows

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`recordIdentityDowngrades` (a sync that renames a file records what the old page held) ran four statements through
`executeRaw`: the soft-deleted page the file once backed, the live pages at its new path, what a carry would move, and the
checkpoint row that keeps the record. PGLite and Postgres run the same SQL, now in
`src/core/engine-sql/collate-identity-downgrades.ts`. The store answers from its page, fact, link and alias records
(`crates/gbrain-store/src/identity_downgrades.rs`) and its checkpoint parent row
(`crates/gbrain-store/src/op_checkpoint_values.rs`); it has no keys of its own. The TypeScript members are in
`src/core/rust-engine/store-members/collate-identity-downgrades.ts`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readSoftDeletedPageAtOrigin(sourceId, path, slug)` | `{ id, slug, deleted_at }` or `null` | `readSoftDeletedPageAtOrigin` |
| `brain.listLivePagesAtOrigin(sourceId, sourcePath)` | `[{ id, slug }]` by slug bytes | `listLivePagesAtOrigin` |
| `brain.countPageCarryRows(sourceId, slug, pageId)` | `{ facts, links, aliases }` | `countPageCarryRows` |
| `brain.writeOpCheckpointValues(op, fingerprint, values)` | nothing; `completed_keys` is now the JSON array `values` | `writeOpCheckpointValues` |
| `brain.readOpCheckpointValues(op, fingerprint)` | the stored array, or `null` when there is no row | `readOpCheckpointValues` |

## What each member answers

| Member | Notes |
| --- | --- |
| `readSoftDeletedPageAtOrigin` | A soft-deleted page whose `source_path` is `path`, or that has no path and the slug `slug`: the latest `deleted_at` first, the lowest id among equal deletions. `deleted_at` is the `timestamptz::text` form (`2026-01-01 00:00:00+00`). |
| `listLivePagesAtOrigin` | Live pages whose `source_path` is `sourcePath`, by slug byte (`ORDER BY slug COLLATE "C"`). The caller used the page-origin guard's `canonicalOriginPage`, whose read ordered by the database's locale; the typed member orders by byte so every engine names the same canonical page. |
| `countPageCarryRows` | Facts about the slug in the source, links of the page at either end (a link between the page and itself counts once), and the slug's aliases. |
| `writeOpCheckpointValues` / `readOpCheckpointValues` | The checkpoint parent row of `writeOpCheckpointKeys`: key `d 0x02 <op> 0x00 <fingerprint>`, value `{ completed_keys, updated_at_us }`. A write replaces `completed_keys` and stamps now; a missing row is created. `readOpCheckpointKeys` reads the same row. The identity-downgrade record and the phantom-redirect rotation each keep one JSON object as the single array element. The module builds the key and row shape itself because the persistence tree is not edited. |
