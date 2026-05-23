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
import type { BrainEngine } from './engine.ts';
import { parseSourceConfig, type SourceRow } from './sources-load.ts';

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
    const lagSeconds = lastMs === null
      ? null
      : Math.max(0, Math.floor((now - lastMs) / 1000));

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
