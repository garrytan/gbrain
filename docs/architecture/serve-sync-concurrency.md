# `gbrain serve` ↔ `gbrain sync` concurrency (PGLite)

**Short version: on a PGLite brain, stop `gbrain serve` before a large sync.**

## Why

PGLite is a single-writer embedded Postgres (WASM). A running `gbrain serve`
(stdio or HTTP MCP) holds an open PGLite connection on the brain's data
directory. `gbrain sync` needs to write to that same data directory. The two
contend for PGLite's single-writer connection / write-lock — **this is NOT the
`gbrain-sync` advisory lock** (that's a separate, DB-row coordination lock for
two concurrent *syncs*). Confusing the two sends you debugging the wrong surface.

Symptoms of serve↔sync contention on PGLite:

- `gbrain sync` blocks acquiring the PGLite write lock, or makes very slow
  progress, while a `gbrain serve` process is alive on the same brain.
- Killing stale `gbrain serve` MCP processes frees the lock and sync proceeds.

## What to do

1. Stop any `gbrain serve` process for this brain before a large sync:
   ```bash
   pkill -f 'gbrain serve'      # or stop your MCP client / Claude Desktop / Cursor
   gbrain sync --no-pull --no-embed --yes
   ```
2. Restart `gbrain serve` after the sync completes.

This contention does **not** apply to the Postgres engine — Postgres tolerates
concurrent connections, so `serve` and `sync` can run simultaneously there.

## Diagnosing a sync hang

If a sync wedges (no progress, high CPU), re-run with the per-file begin trace
so the stalling file is named:

```bash
GBRAIN_SYNC_TRACE=1 gbrain sync --no-pull --no-embed --yes
```

The last `[sync] begin import: <path>` line with no following completion is the
file being processed when the hang occurred. Under `--workers >1` / `--all`,
the stuck file is in the set of begin-lines without a matching completion.

If you suspect a schema-pack regex is the cause (a pack with a
catastrophic-backtracking `inference.regex`), complete the sync with the pack
disabled and re-run extraction afterward:

```bash
gbrain sync --no-schema-pack --no-pull --no-embed --yes
```

`gbrain schema lint` flags the classic nested-quantifier ReDoS shapes
(`(a+)+`, `(a*)*`, …) in pack regexes as warnings.

---

## Postgres Sync Concurrency

Unlike PGLite, the Postgres engine supports concurrent connections, allowing parallel imports.

### CLI Tuning Flags
You can configure the concurrency level of parallel imports during sync:
* **`--workers N`** (alias **`--concurrency N`**): The number of worker processes to spawn. Explicitly passing this bypasses the 50-file floor.
* **Auto-concurrency**: When no override is passed:
  * Spawns `DEFAULT_PARALLEL_WORKERS = 4` if the number of files to import is greater than `AUTO_CONCURRENCY_FILE_THRESHOLD = 100`.
  * Otherwise, runs serially (1 worker) to avoid setup overhead on trivial diffs.
  * For auto-concurrency to run, the file count must exceed `PARALLEL_FILE_FLOOR = 50`.

### Connection Budget Clamping (`GBRAIN_MAX_CONNECTIONS`)
If you run behind a low-cap connection pooler (like Supabase Supavisor's 20-client transaction pooler), parallel syncs can trigger connection failures (`EMAXCONNSESSION`).
To prevent this, set the **`GBRAIN_MAX_CONNECTIONS`** environment variable:

```bash
export GBRAIN_MAX_CONNECTIONS=15
```

When set, `gbrain` calculates the connection footprint:
`footprint = parentPool + (workers * perWorkerPool)`
* `parentPool` is resolved via `resolvePoolSize()`.
* `perWorkerPool` is bounded to `min(2, resolvePoolSize(2))`.

If the footprint exceeds `GBRAIN_MAX_CONNECTIONS`, the worker count is automatically clamped down to fit the budget. If even one parallel worker cannot fit, sync falls back to the serial path (using only the parent connection pool).

---

## Queue Job & Autopilot Concurrency

Background workers and the autopilot daemon manage tasks using the Minions queue layer. Under the hood:

1. **`import` Jobs**:
   You can specify worker concurrency directly inside the job payload:
   ```json
   {
     "dir": "/path/to/brain",
     "concurrency": 4
   }
   ```
   If `concurrency` (or its fallback alias `workers`) is specified as a number in `job.data`, the queue worker forwards this value as the `--workers` option during the import run.

2. **`autopilot-cycle` / `dream` Jobs**:
   During the nightly maintenance cycle, you can pass a custom concurrency level:
   ```json
   {
     "concurrency": 2
   }
   ```
   If present, the autopilot daemon passes this concurrency down to `runCycle` options, which forwards it to the sync phase (`performSync`). This ensures that background maintenance cycles respect host resources and connection budgets.
