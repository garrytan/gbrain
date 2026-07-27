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
