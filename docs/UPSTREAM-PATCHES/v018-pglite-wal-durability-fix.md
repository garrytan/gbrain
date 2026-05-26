# Fork-local patch: PGLite WAL durability on close

> 2026-04-23 | Jarvis KOS v2 fork | pending upstream filing.
> Second fork-local `src/*` patch after
> [v018-pglite-upgrade-fix.md](v018-pglite-upgrade-fix.md).
>
> **Status checks**:
> - 2026-04-25 (v0.20.4 sync, commit `8665afb`): upstream
>   `src/core/pglite-engine.ts:75` still calls bare `await this._db.close()`
>   in `disconnect()` with no WAL flush. Patch retained.
> - 2026-05-26 (v0.41.14.0 sync, §6.31): upstream v0.41.8.0 refactored
>   `disconnect()` into snapshot-and-early-null + try/finally pattern
>   (closes partial-state race PR #1337) but still does NOT flush the
>   WAL. Fork patch **folded INTO** the new upstream structure — the
>   `pg_switch_wal()` call now lives inside the `try { if (db) { ... } }`
>   block before `db.close()`, gaining upstream's lock-release try/finally
>   guarantee while preserving the WAL flush. Patch sites both alive:
>   `src/core/pglite-engine.ts:283` + `skills/kos-jarvis/_lib/brain-db.ts:164`.
>   Upstream PR opportunity is BETTER now (less merge surface), but
>   bug-class hypothesis still untested on Linux CI.

## What was wrong

On this deployment (pglite 0.4.4 on macOS 26.3 via Bun 1.3.x), every
`gbrain link`, `gbrain tag`, and direct `PGlite.create → INSERT →
db.close()` sequence silently lost its write. The CLI printed
`{"status":"ok"}`, exited 0, but a fresh `PGlite.create()` on the same
`dataDir` loaded `MAX(id)` pre-insert.

Minimal reproducer:

```ts
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const db = await PGlite.create({
  dataDir: "/path/to/brain.pglite",
  extensions: { vector, pg_trgm },
});
const before = (await db.query("SELECT MAX(id)::int AS n FROM links")).rows[0].n;
await db.query(
  `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source)
   VALUES (2942, 3045, 'probe', 'probe-ctx', 'manual')`,
);
const after = (await db.query("SELECT MAX(id)::int AS n FROM links")).rows[0].n;
await db.close();

const db2 = await PGlite.create({ dataDir: "/path/to/brain.pglite",
  extensions: { vector, pg_trgm } });
const fresh = (await db2.query("SELECT MAX(id)::int AS n FROM links")).rows[0].n;
// before=N, after=N+1, fresh=N   ← fresh should be N+1
```

Diagnostic signal (manual `CHECKPOINT` before close):

```
ERROR: xlog flush request 0/5DADA990 is not satisfied --- flushed only to 0/5DA8C080
```

The WAL buffer records the INSERT, reports the new LSN in-process, but
the durable LSN on disk is stalled behind. On `db.close()` the in-memory
state vanishes; on reopen, postgres recovery replays WAL from disk up to
the last durable position, silently dropping anything after.

Things that did NOT matter:
- Concurrency with kos-compat-api (the bug repros with `launchctl bootout` on it)
- `file://` URL prefix vs bare `dataDir` path
- pgvector / pg_trgm extension loading order
- `syncToFs()` on its own

## What the patch does

Before `db.close()`, issue `SELECT pg_switch_wal()`. This forces a WAL
segment rotation, which in turn flushes the current WAL buffer to disk
and advances the durable LSN past any outstanding inserts. After the
switch, a follow-up `CHECKPOINT` also succeeds (was erroring before), so
`pg_switch_wal` is doing the real work.

Applied in two places:

1. `src/core/pglite-engine.ts` — `PGLiteEngine.disconnect()`. This
   covers every CLI path (`gbrain link`, `gbrain tag`, `gbrain put_page`
   subprocess, `gbrain extract`, etc.) and any in-process use of
   `PGLiteEngine`.
2. `skills/kos-jarvis/_lib/brain-db.ts` — `BrainDb.close()`. This is
   the fork-local PGLite reader used by dikw-compile, orphan-reducer,
   kos-compat-api's handleStatus/handleDigest, and the ingest/digest
   paths.

Both sites wrap the `pg_switch_wal()` call in a try/catch — the close
still proceeds if the switch fails. Read-only handles make the switch a
no-op (no new WAL records to rotate).

## Why not syncToFs / CHECKPOINT directly

- `db.syncToFs()` alone does not advance the durable LSN; it only syncs
  the already-durable bytes to the host filesystem. If the durable LSN
  is stale, syncToFs syncs stale data.
- Manual `CHECKPOINT` before `pg_switch_wal` fails with `xlog flush
  request not satisfied`. The checkpointer refuses to checkpoint past
  an LSN it hasn't flushed. Only after `pg_switch_wal` advances the
  durable LSN does `CHECKPOINT` succeed — and at that point the patch
  is already working, so adding CHECKPOINT is redundant.
- `SET synchronous_commit=on` is the default in pglite. The bug is
  WAL-writer throughput on macOS WASM, not a commit-level setting.

## Why not wait for upstream

The loss is silent and affects every CLI write. Keeping fork-local
until upstream triage is the only way to unblock orphan-reducer
(P0-A in `skills/kos-jarvis/TODO.md`), `gbrain link` / `gbrain tag`
CLI round-trips, and any write path that relies on close-before-next
process-open. Upstream filing will follow once we confirm whether this
is macOS-specific (suspect) or hits Linux CI too.

## Fork obligations

When upstream ships a persistent fix (likely on a pglite bump past
0.4.4, or a patch to `_db.close()` to force WAL switch internally):

1. Remove both `try { await this._db.query('SELECT pg_switch_wal()'); } catch {}`
   blocks (src/core/pglite-engine.ts + skills/kos-jarvis/_lib/brain-db.ts).
2. Delete this doc.
3. If upstream took a different approach (e.g. `syncToFs()` fix, schema
   migration, or a PGLite runtime flag), diff the upstream change
   against this patch before resolving.

## Validation

Before patch:
```
before: 395, after: 396, fresh: 395, probe row: []
```

After patch (isolated: only `pg_switch_wal` before close, no CHECKPOINT,
no syncToFs):
```
before: 397, after: 398, fresh: 398, probe row: [{id:398,link_type:"isolate-switchwal-only"}]
```

Also replayed through orphan-reducer `--apply --limit 5 --no-commit`:
edges persist across `gbrain stats` reloads and appear in
`gbrain backlinks <orphan>` output.

## Files touched

- `src/core/pglite-engine.ts` — this patch (disconnect body)
- `skills/kos-jarvis/_lib/brain-db.ts` — this patch (close body)
- `docs/UPSTREAM-PATCHES/v018-pglite-wal-durability-fix.md` — this record
