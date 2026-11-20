# The brain store: pending core-edit notices

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`listPendingCoreNotices(sourceIds?)` is the read that the session-start core block, `gbrain core status` and the doctor
`core_memory` check ran through `executeRaw` against `core_edit_notices`. PGLite and Postgres run one constant statement
per shape (`src/core/engine-sql/core-notices.ts`): the pending (unacked) notices, one per page with the newest id winning,
ordered by source then slug in byte order (`COLLATE "C"`), at most 50. `null` or no argument reads every source; a list
reads those sources only; an empty list reads none.

The store keeps no core-edit notices: no store writer runs the core-page guard that records them. The Rust engine has
no store member for this read, so it refuses by name (`engine_capability_missing`, capability `pages`,
`member=listPendingCoreNotices`). It never answers an empty list, which a caller would read as "no remote edits".

The callers turn the refusal, and any other read error, into "unknown" (`readPendingCoreNotices` in
`src/core/core-memory.ts`); only a brain from before the notices table reads no notices:

| Caller | On the refusal |
| --- | --- |
| core block (`loadCoreBlock`) | one line, `Remote edits to core pages are unknown on this brain: <message>`, in place of the notices; the block revision is unchanged |
| `gbrain core status` | `pending_notices: null` and `pending_notices_unknown: {code, message}` (`engine_capability_missing` here; another error's own code, or `read_failed`); the text output prints a `notices:` line |
| doctor `core_memory` | warn, `remote edits to core pages are unknown on this brain (<message>)`, with the same two details |

Parity: `test/engine-parity/core-notices.test.ts`. Callers: `test/core-notices-capability-refusal.test.ts`.
