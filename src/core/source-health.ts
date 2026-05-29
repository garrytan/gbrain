/**
 * Per-source health metrics (v0.40 D12 + D9 + D17 + D19).
 *
 * Single source of truth for `gbrain sources status` AND `gbrain doctor`'s
 * `federation_health` check. Sharing the implementation prevents the dashboard
 * and the doctor warning from drifting.
 *
 * D12: batched GROUP BY queries — 4 queries total instead of 6×N per-source
 *      round-trips. On a 4-source / 300K-chunk brain this drops dashboard
 *      time from ~24s to <2s.
 *
 * D9:  resolvePriority(config) — accepts 'high'|'normal'|'low', falls back
 *      to 0 with once-per-source-per-process stderr warn on unknown values.
 *
 * D17: isSourceStale helper — autopilot calls this to decide per-source
 *      sync dispatch independent of the brain_score gate.
 */
import { existsSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import type { BrainEngine } from './engine.ts';
import { parseSourceConfig, type SourceRow } from './sources-load.ts';

/**
 * Newest-content timestamp for a source's local checkout, in epoch ms, or
 * `null` when it can't be determined cheaply.
 *
 * Staleness must measure how far the sync is behind the source's *content*
 * ("what was last committed to the repo"), NOT wall-clock time since the
 * last sync. A repo that hasn't changed in a week is fully caught up, not
 * "severely stale" — flagging it is a false positive that trains operators
 * to ignore the alert.
 *
 * Definition: "what was last committed to the repo." We deliberately do NOT
 * count untracked working-tree files (build artifacts, scratch dirs, staging
 * areas) — those are exactly the noise that produced false SEVERE alerts on
 * otherwise-idle repos. The signal is committed + tracked-modified content:
 *   1. git HEAD commit time (`git log -1 --format=%ct`).
 *   2. Newest mtime among TRACKED modified paths only (`git status
 *      --porcelain -z` rows whose status is not `??`). A tracked edit that
 *      hasn't been committed yet is still "content the operator authored";
 *      an untracked file is not yet part of the repo.
 *
 * Non-git directories and unreadable paths return `null`; callers then fall
 * back to the legacy wall-clock measure so detection never regresses where
 * we genuinely can't probe content.
 */
export function newestContentMs(localPath: string | null): number | null {
  if (!localPath || !existsSync(localPath)) return null;
  let newest: number | null = null;
  try {
    const commitSec = execFileSync(
      'git',
      ['-C', localPath, 'log', '-1', '--format=%ct'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    ).trim();
    if (commitSec) {
      const ms = Number(commitSec) * 1000;
      if (Number.isFinite(ms)) newest = ms;
    }
  } catch {
    return null; // not a git repo / git unavailable — caller falls back
  }
  try {
    const porcelain = execFileSync(
      'git',
      ['-C', localPath, 'status', '--porcelain', '-z'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    );
    for (const entry of porcelain.split('\0')) {
      if (!entry) continue;
      // Porcelain row: "XY <path>". Skip untracked ('??') — not yet repo
      // content. Count tracked modifications (M/A/R/etc.).
      const status = entry.slice(0, 2);
      if (status === '??') continue;
      const rel = entry.slice(3);
      if (!rel) continue;
      try {
        const ms = statSync(join(localPath, rel)).mtimeMs;
        if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
      } catch { /* deleted/inaccessible — skip */ }
    }
  } catch { /* status failed — keep commit-time signal */ }
  return newest;
}

/**
 * Content-relative lag in seconds: how long the sync has been behind the
 * source's newest content. `0` when caught up (newest content ≤ last sync),
 * `null` when last sync is unknown.
 *
 * When content CAN'T be probed (non-git / unreadable path) it falls back to
 * the raw wall-clock delta `(now - lastSync)` — NOT clamped at 0 — so callers
 * that detect clock skew via a negative result still work. When content IS
 * probed and the source is caught up, it returns exactly `0`.
 */
export function contentRelativeLagSeconds(
  localPath: string | null,
  lastSyncMs: number | null,
  nowMs: number,
): number | null {
  if (lastSyncMs === null || !Number.isFinite(lastSyncMs)) return null;
  const wallClockSeconds = Math.floor((nowMs - lastSyncMs) / 1000);
  // Negative wall-clock means last sync is in the future — clock skew. Surface
  // it (don't mask as caught-up) so upstream skew detection still fires.
  if (wallClockSeconds < 0) return wallClockSeconds;
  const contentMs = newestContentMs(localPath);
  if (contentMs !== null) {
    // Caught up iff newest content is at or before the last sync.
    return contentMs <= lastSyncMs ? 0 : wallClockSeconds;
  }
  // No content signal — wall-clock fallback (already ≥ 0 here).
  return wallClockSeconds;
}

export interface SourceMetrics {
  source_id: string;
  name: string;
  local_path: string | null;
  federated: boolean;
  total_pages: number;
  total_chunks: number;
  embedded_chunks: number;
  embed_coverage_pct: number;
  last_sync_at: Date | null;
  lag_seconds: number | null;
  /** Failed jobs (sync OR embed-backfill) for this source in last 24h. */
  failed_jobs_24h: number;
  /** Waiting + active + delayed jobs (sync OR embed-backfill) for this source. */
  queue_depth: number;
  tracked_branch: string | null;
  priority_label: PriorityLabel;
  /** Webhook configured? (true iff config.webhook_secret is set.) */
  webhook_configured: boolean;
}

export type PriorityLabel = 'high' | 'normal' | 'low';

/** Numeric priority used by MinionQueue.add({ priority }). Lower = sooner. */
const PRIORITY_VALUE: Record<PriorityLabel, number> = {
  high: -10,
  normal: 0,
  low: 5,
};

const KNOWN_PRIORITY: Set<string> = new Set(['high', 'normal', 'low']);

/** Stderr-warn-once memo so a tight autopilot loop doesn't spam. */
const _warnedSources = new Set<string>();

/** Test seam: reset memo so unit tests can re-trigger the warn path. */
export function _resetPriorityWarningsForTest(): void {
  _warnedSources.clear();
}

/**
 * Resolve a source's priority label from its config row.
 *
 * Recognized values: 'high', 'normal', 'low'. Anything else (typos, integers,
 * nested objects) falls back to 'normal' AND emits a once-per-source-per-
 * process stderr warning naming the bad value + the fix command. Missing
 * key is silent ('normal' is the default).
 */
export function resolvePriorityLabel(
  sourceId: string,
  config: unknown,
): PriorityLabel {
  const parsed = parseSourceConfig(config);
  const raw = parsed.priority;
  if (raw === undefined || raw === null) return 'normal';
  if (typeof raw === 'string' && KNOWN_PRIORITY.has(raw)) {
    return raw as PriorityLabel;
  }
  // Warn once per source per process.
  if (!_warnedSources.has(sourceId)) {
    _warnedSources.add(sourceId);
    process.stderr.write(
      `[gbrain] source "${sourceId}": invalid config.priority value ${JSON.stringify(raw)}; ` +
      `falling back to 'normal'. Fix: gbrain sources config set ${sourceId} priority normal\n`,
    );
  }
  return 'normal';
}

/** Numeric priority for queue.add. */
export function resolvePriority(sourceId: string, config: unknown): number {
  return PRIORITY_VALUE[resolvePriorityLabel(sourceId, config)];
}

/**
 * True iff the source's last_sync_at is older than `intervalMs`, OR it has
 * never synced. Sources without a local_path are NOT considered stale (no
 * way to sync them). Used by autopilot D17 freshness gate.
 */
export function isSourceStale(src: SourceRow, intervalMs: number): boolean {
  if (!src.local_path) return false;
  if (!src.last_sync_at) return true;
  const lastMs = new Date(src.last_sync_at).getTime();
  // Content-relative: a source is only stale if its newest content is newer
  // than the last sync AND that gap exceeds the interval. A quiet repo whose
  // newest commit predates its last sync is caught up — don't re-dispatch it.
  const contentMs = newestContentMs(src.local_path);
  if (contentMs !== null && contentMs <= lastMs) return false;
  return Date.now() - lastMs >= intervalMs;
}

/**
 * Compute per-source metrics for every source in one shot.
 *
 * Batched GROUP BY pipeline:
 *   1. sources: id, name, local_path, last_sync_at, config (one SELECT)
 *   2. pages by source_id (one GROUP BY)
 *   3. chunks by source_id with FILTER(embedding NOT NULL) (one GROUP BY)
 *   4. minion_jobs by data->>'sourceId' with FILTERs for failed-24h + queue depth
 *
 * Total: 4 queries regardless of source count. Each scans the relevant table
 * once. Same cost as the slowest single-source query in the old per-source loop.
 */
export async function computeAllSourceMetrics(
  engine: BrainEngine,
  sources: SourceRow[],
): Promise<SourceMetrics[]> {
  if (sources.length === 0) return [];

  const pageCounts = await pageCountsBySource(engine);
  const chunkCounts = await chunkCountsBySource(engine);
  const jobCounts = await jobCountsBySource(engine);
  const now = Date.now();

  return sources.map((src) => {
    const cfg = parseSourceConfig(src.config);
    const pages = pageCounts.get(src.id) ?? 0;
    const chunkStats = chunkCounts.get(src.id) ?? { total: 0, embedded: 0 };
    const jobStats = jobCounts.get(src.id) ?? { failed_24h: 0, queue_depth: 0 };

    const embedCoverage = chunkStats.total === 0
      ? 100
      : Math.round((chunkStats.embedded / chunkStats.total) * 1000) / 10;

    const lastMs = src.last_sync_at ? new Date(src.last_sync_at).getTime() : null;
    // Content-relative: lag is the gap to the source's newest content
    // ("what was last committed"), not wall-clock since the last sync. A
    // quiet repo whose newest commit predates its last sync reports lag 0
    // and no longer trips the doctor's federation_health staleness alarm.
    const lagSeconds = contentRelativeLagSeconds(src.local_path, lastMs, now);

    return {
      source_id: src.id,
      name: src.name,
      local_path: src.local_path,
      federated: cfg.federated === true,
      total_pages: pages,
      total_chunks: chunkStats.total,
      embedded_chunks: chunkStats.embedded,
      embed_coverage_pct: embedCoverage,
      last_sync_at: src.last_sync_at,
      lag_seconds: lagSeconds,
      failed_jobs_24h: jobStats.failed_24h,
      queue_depth: jobStats.queue_depth,
      tracked_branch: typeof cfg.tracked_branch === 'string' ? cfg.tracked_branch : null,
      priority_label: resolvePriorityLabel(src.id, src.config),
      webhook_configured: typeof cfg.webhook_secret === 'string' && cfg.webhook_secret.length > 0,
    };
  });
}

async function pageCountsBySource(engine: BrainEngine): Promise<Map<string, number>> {
  const rows = await engine.executeRaw<{ source_id: string; n: number }>(
    `SELECT source_id, COUNT(*)::int AS n
       FROM pages
      WHERE deleted_at IS NULL
      GROUP BY source_id`,
  );
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.source_id, Number(r.n));
  return m;
}

async function chunkCountsBySource(engine: BrainEngine): Promise<Map<string, { total: number; embedded: number }>> {
  const rows = await engine.executeRaw<{ source_id: string; total: number; embedded: number }>(
    `SELECT p.source_id,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE c.embedding IS NOT NULL)::int AS embedded
       FROM content_chunks c
       JOIN pages p ON p.id = c.page_id
      WHERE p.deleted_at IS NULL
      GROUP BY p.source_id`,
  );
  const m = new Map<string, { total: number; embedded: number }>();
  for (const r of rows) m.set(r.source_id, { total: Number(r.total), embedded: Number(r.embedded) });
  return m;
}

async function jobCountsBySource(engine: BrainEngine): Promise<Map<string, { failed_24h: number; queue_depth: number }>> {
  // Pre-v0.11 brains don't have minion_jobs; return empty map.
  try {
    const rows = await engine.executeRaw<{ source_id: string; failed_24h: number; queue_depth: number }>(
      `SELECT data->>'sourceId' AS source_id,
              COUNT(*) FILTER (WHERE status IN ('failed','dead') AND created_at > NOW() - INTERVAL '24 hours')::int AS failed_24h,
              COUNT(*) FILTER (WHERE status IN ('waiting','active','delayed'))::int AS queue_depth
         FROM minion_jobs
        WHERE name IN ('sync','embed-backfill')
          AND data->>'sourceId' IS NOT NULL
        GROUP BY data->>'sourceId'`,
    );
    const m = new Map<string, { failed_24h: number; queue_depth: number }>();
    for (const r of rows) {
      m.set(r.source_id, { failed_24h: Number(r.failed_24h), queue_depth: Number(r.queue_depth) });
    }
    return m;
  } catch {
    return new Map();
  }
}
