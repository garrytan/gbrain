# Upstream issue draft: dream-cycle extract phases silently fail with "No database connection" in v0.41.x

**Status**: draft, ready to file against `garrytan/gbrain`. Discovered 2026-05-26 (post v0.41.14.0 fork sync §6.31). Production impact: 8+ days of nightly dream-cycle reports showing `ok extract: 0 link(s)` but actually losing every batch insert.

**Affected file**: `src/commands/extract.ts:712` (`engine.addLinksBatch(snapshot)`); related: `src/cli.ts:1068-1093` (dream command engine lifecycle).

---

## Title

dream-cycle `extract.links_fs` / `extract.timeline_fs` phases silently fail with `No database connection: connect() has not been called` on every batch — Postgres engine, v0.41.x

## Summary

On a healthy Postgres setup (daemon `gbrain serve --http` working fine), invoking `gbrain dream` from CLI causes every batch insert during `extract.links_fs` and `extract.timeline_fs` to fail with `No database connection: connect() has not been called`. The phase nonetheless reports `status: ok` (because successful-count is 0 and no phase-level error is raised), so production cron silently no-ops indefinitely.

## Reproduction

Fork-side gbrain 0.41.14.0, macOS 26.3, Bun 1.3.x, Postgres 16 at `127.0.0.1:5432`, ~3100 markdown pages under `~/brain/`. `~/.gbrain/config.json`:

```json
{
  "engine": "postgres",
  "database_url": "postgresql://USER@127.0.0.1:5432/gbrain",
  "embedding_model": "google:gemini-embedding-001",
  "embedding_dimensions": 1536
}
```

The same Postgres process is used by `gbrain serve --http` (running concurrently and healthy — `/health` returns ok, `put_page` / `query` etc. all work via MCP).

```bash
gbrain dream --json --dir ~/brain
```

Output excerpt (3000+ batches all fail):

```
[cycle.extract] start
[extract.links_fs] start
[extract.links_fs] connection blip, retrying 100 rows in 500ms (No database connection: connect() has not been called. Fix: Run gbrain init --supabase or gbrain init --url <connection_string>)
  batch error (100 link rows lost): No database connection: connect() has not been called. Fix: Run gbrain init --supabase or gbrain init --url <connection_string>
[extract.links_fs] 30/3099 (0%)
[continues for all 3099 pages, every batch fails the same way]
...
[extract.links_fs] 3099/3099 (100%) done
[extract.timeline_fs] start
[same failure pattern]
[extract.timeline_fs] 3099/3099 (100%) done
[cycle.extract] done
```

Final JSON report from `gbrain dream --json`:

```json
{
  "status": "partial",
  "phases": [
    ...
    {
      "phase": "extract",
      "status": "ok",
      "summary": "0 link(s), 0 timeline entries (incremental: 0 slugs)"
    },
    ...
  ]
}
```

Note: phase status is `ok` despite 100% of batches failing. The successful-count happens to equal the to-process-count (both 0 after the retries exhaust), so the phase summary reports a "clean noop" when in fact every batch failed.

## What's puzzling

The `[dream] WARNING: could not connect to DB` line from `src/cli.ts:1082-1086` does **NOT** fire — `connectEngine()` returns without throwing. But the engine instance reaching `extract.links_fs` clearly isn't connected:

```ts
// src/cli.ts:1068-1093 (dream command)
let eng: BrainEngine | null = null;
try {
  eng = await connectEngine();       // ← succeeds, no warning
} catch (err) {
  process.stderr.write(`[dream] WARNING: could not connect to DB ...`);
}
await runDream(eng, args);            // ← engine passed in

// Inside the cycle later:
// src/commands/extract.ts:711-712
created += await withRetry(
  () => engine.addLinksBatch(snapshot),   // ← throws "No database connection: connect() has not been called"
  ...
);
```

Either:
- The engine instance reaching `addLinksBatch` is NOT the one cli.ts connected (lifecycle drift / singleton resolution issue across cycle phases), OR
- The connection got reset / disconnected between phases, OR  
- `engine.connect()` succeeds but doesn't actually open a working Postgres connection (silent lazy init that defers connection until first query, and that deferred connect fails)

## Production impact

The fork has been running the nightly dream-cycle since v0.40.x via a `launchd` plist that fires `gbrain dream --json --dir ~/brain` at 03:11 daily. Reports archived to `~/brain/.agent/dream-cycles/<ISO>.json`. **Every report from 2026-05-19 to 2026-05-26 (8 days) shows `partial` status with `0 link, 0 timeline entries`** — i.e. extract has been silently broken in production for at least 8 days, possibly since the §6.28 (2026-05-17) cutover when the brain transitioned to DB-canonical mode (no more markdown write-through).

This is a particularly bad failure mode because:
- Cron exits 0 (status `partial` with all phases `ok` / `warn` / `skipped`)
- launchd doesn't flag it
- The archived JSON report looks normal in skim — only the bare "0 links" tells you anything
- batch errors only surface on stderr (manual run reveals them; cron silently discards them)

## Suggestion (priority order)

1. **Phase-level error escalation** (highest priority): when a batch operation throws "No database connection", the cycle phase should bubble that error and report phase `status: failed`, not `ok`. Hiding production failure behind an `ok` summary is the worst failure mode.

2. **Engine instance audit**: trace why `engine.addLinksBatch` sees an unconnected engine when `cli.ts` clearly called `connectEngine()` successfully. Look for singleton vs per-phase engine resolution; check if `runDream` or its subroutines re-instantiate an engine that bypasses the connect call.

3. **Health probe in `runDream`**: cheap sanity check at the top — `await engine.executeRaw('SELECT 1')` — and if it fails, throw before the cycle starts so the "could not connect" path actually fires. The current `try { connectEngine() } catch` only catches errors that happen during `connectEngine`, not connection-state issues that surface later.

## Workaround (current)

None known. `--dry-run` succeeds because no writes happen, but no actual links/timeline are extracted. Production fork is currently relying on the daemon (`gbrain serve --http`) for all DB writes via MCP `put_page` etc. (those work fine, daemon has its own connection lifecycle).

## Related notes

- Fork's `~/.gbrain/config.json` is the standard shape per docs.
- No env shadow of `DATABASE_URL` — config-only.
- M3 cutover (2026-05-10) retired an in-process embed-shim; this issue is independent of that (the bug is in core DB engine lifecycle, not embedding).
- `gbrain init` works fine; this happens AFTER successful init.
