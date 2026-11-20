# The brain store: the phantom-redirect pass's root-page walk

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The phantom-redirect pass (`src/core/cycle/phantom-redirect.ts`) walks a source's live root pages (slugs with no `/`) a
window at a time, resuming after the last slug it examined, to find stub pages a canonical page should replace. It read
each window through `executeRaw`. PGLite and Postgres run the same SQL, now in
`src/core/engine-sql/collate-phantom-redirect.ts`. The store answers from its page records
(`crates/gbrain-store/src/phantom_redirect.rs`) and has no keys of its own. The TypeScript member is in
`src/core/rust-engine/store-members/collate-phantom-redirect.ts`.

The pass keeps its resume cursor with the rotation helpers (`src/core/repair/rotation.ts`), which now go through the
checkpoint value members of [collate-identity-downgrades.md](collate-identity-downgrades.md) (`readOpCheckpointValues`,
`writeOpCheckpointValues`, value `[{ last }]`) instead of raw SQL.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listRootPageSlugsAfter(sourceId, after, exclude, limit)` | `[slug]`, at most `limit` | `listRootPageSlugsAfter` |

## What it answers

The source's live pages whose slug has no `/`, whose slug bytes sort after `after` (`''` for the start), that are not in
`exclude` (the held slugs), ordered by slug bytes. Text with a NUL byte in `sourceId` or `after` refuses, as Postgres does.
The pass's facts, link and timeline steps on a real phantom still run raw SQL and are not part of this member.
