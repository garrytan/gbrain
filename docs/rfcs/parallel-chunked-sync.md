# RFC: Parallel Chunked Sync for Large Federated Brains

## Problem Statement

gbrain's sync pipeline becomes a reliability bottleneck at scale (370K+ pages, 4 federated sources). The current architecture has three compounding failure modes that cause sources to fall behind and eventually trigger doctor FAIL alerts.

## Failure Mode 1: Serial Timeout Cascade

**Observed:** The `gbrain-sync-all` cron consistently times out when the total sync+embed cycle exceeds the cron timeout window.

When run via an agent cron (the primary production path), the sync job has a fixed timeout. The pipeline processes sources sequentially in a single agent turn:

```
git pull (4 sources) → sync default → sync straylight → sync zion → sync media-corpus → embed --stale
```

Even with `--no-embed`, each source's sync takes variable time (depends on diff size, chunk count, DB write latency). When any source has a large backlog, the total wall time pushes past the timeout, and the **entire run** is killed — including sources that haven't been reached yet.

**Production data (last 24h):**
- 8 of 12 runs timed out at exactly 1803s (30-min timeout)
- When runs succeed, they take 1100-1800s (cutting it close every time)
- Sources later in the queue (media-corpus, straylight-brain) go 50+ hours without a successful sync

**Root cause:** The pipeline is monolithic. There's no way to sync one source without risking a timeout that kills all sources.

## Failure Mode 2: Lock Contention Between Cron Waves

**Observed:** When a sync run times out, the next hourly cron fires and finds a stale lock from the previous run.

The per-source lock mechanism (introduced in PR #1314) correctly prevents concurrent syncs of the same source. But when a timed-out run leaves a lock behind, the next run can't acquire it and skips that source entirely. The result is a cascade: timeout → stale lock → skip → source falls further behind → next sync has even more work → longer timeout.

The `--break-lock` flag exists but can't be combined with `--all`, requiring per-source manual intervention:
```bash
for src in $(gbrain sources list --json | jq -r '.[].id'); do
  gbrain sync --break-lock --source "$src"
done
```

This is not a recoverable path for an automated cron.

## Failure Mode 3: Embed Phase Blocks Sync Phase

**Observed:** `embed --stale` after sync can take 20+ minutes when there's a backlog, eating into the timeout budget that sync needs.

The v0.40.6 embed-backfill auto-submit (D18) mitigates this by deferring embed to a job queue, but only under the parallel code path with `federated_v2` enabled. The common single-source path still embeds inline.

## Current Architecture Constraints

The sync pipeline has good building blocks that aren't fully leveraged:

1. **Per-source locks** exist (`syncLockId(sourceId)`) — sources CAN be independent
2. **Parallel fan-out** exists (`pMapAllSettled` with `--max-sources`) — but only under `sync --all`
3. **Embed-backfill auto-submit** exists — but only on the v2 parallel path
4. **Source-level bookmarks** exist — each source tracks its own `last_commit`/`last_sync_at`
5. **The `sync trigger` sub-command** exists — designed for webhook-triggered per-source sync

What's missing: a way for external orchestrators (crons, webhooks, monitoring) to **independently schedule each source** with proper timeout isolation, without going through the monolithic `sync --all` path.

## Proposed Solution: Independent Source Sync with Chunked Processing

### 1. `gbrain sync --source <id> --timeout <seconds>`

Add a `--timeout` flag that makes sync self-terminate gracefully before the deadline:
- Commits whatever progress has been made
- Releases the lock cleanly
- Exits 0 with a `status: 'partial'` result
- Remaining work is picked up by the next run (incremental by nature)

This turns sync into a **resumable chunked operation** rather than an all-or-nothing batch.

### 2. `gbrain sync --source <id> --break-lock-if-stale <seconds>`

Instead of refusing to run when a lock exists, allow: "if the lock is older than N seconds, assume the holder is dead and break it." This makes cron self-healing without requiring `--break-lock` (which is too aggressive for automation).

### 3. `gbrain sync --all --independent`

Fan out each source as a **separate process** (not just a separate async task within one process). Each source gets its own timeout, its own lock lifecycle, and its own failure domain. One source timing out doesn't affect the others.

Implementation options:
- Fork child processes with per-source timeouts
- Submit per-source sync jobs to the gbrain job queue
- Output structured results that a caller can aggregate

### 4. Deprecate monolithic `sync --all` as the default cron path

The production recommendation should be:
```bash
# Instead of one monolithic sync --all:
gbrain sync --source default --timeout 600 --break-lock-if-stale 1800
gbrain sync --source straylight-brain --timeout 600 --break-lock-if-stale 1800
gbrain sync --source zion-brain --timeout 600 --break-lock-if-stale 1800
gbrain sync --source media-corpus --timeout 600 --break-lock-if-stale 1800
```

Or, if `--independent` is implemented:
```bash
gbrain sync --all --independent --timeout 600 --break-lock-if-stale 1800
```

## Impact

| Metric | Current | After |
|--------|---------|-------|
| Sync reliability | ~33% success rate (4/12 runs) | ~95%+ (each source independent) |
| Max source staleness | 50+ hours (cascade failure) | < 2 hours (worst case = 1 failed run) |
| Recovery from timeout | Manual intervention required | Automatic on next run |
| Lock contention | Cascade across sources | Isolated per source |

## Compatibility

All proposed changes are additive:
- `sync --all` continues to work as-is (default behavior unchanged)
- `--timeout`, `--break-lock-if-stale`, `--independent` are new flags
- No schema changes required
- No changes to the per-source lock protocol

## Related

- PR #1314: Per-source lock isolation
- v0.40.6.0: Parallel fan-out + embed-backfill auto-submit
- `sync trigger` sub-command: Already designed for per-source invocation
