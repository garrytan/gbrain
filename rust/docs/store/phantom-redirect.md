# The brain store: the phantom-redirect pass's root-page walk

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The phantom-redirect pass (`src/core/cycle/phantom-redirect.ts`) walks a source's live root pages (slugs with no `/`) a
window at a time, resuming after the last slug it examined, to find stub pages a canonical page should replace.
`listRootPageSlugsAfter` reads each window; PGLite and Postgres run the SQL of `src/core/engine-sql/facts-cycle.ts`. The
store answers from its page records (`crates/gbrain-store/src/phantom_redirect.rs`) and has no keys of its own. The
TypeScript member is in `src/core/rust-engine/store-members/cycle-reads.ts`.

The pass keeps its resume cursor with the rotation helpers (`src/core/repair/rotation.ts`), which go through the checkpoint
record members (`readOpCheckpointRecords`, `writeOpCheckpointRecords`, value `{ last }`).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listRootPageSlugsAfter(sourceId, take, held, after)` | `[{ slug }]`, at most `take` | `listRootPageSlugsAfter` |

The source's live pages whose slug has no `/`, whose slug bytes sort after `after` (`''` for the start), that are not in
`held`, ordered by slug bytes. Text with a NUL byte in `sourceId` or `after` refuses, as Postgres does.
