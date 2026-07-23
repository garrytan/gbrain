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
 * v0.41.32.0: commit-relative staleness. `lag_seconds` is no longer raw
 *      wall-clock `now - last_sync_at` (which false-flagged quiet, caught-up
 *      repos as SEVERE). Local callers pass `probeContent: true` and lag
 *      becomes 0 when the source is caught up by COMMIT HASH (HEAD ==
 *      last_commit, untracked ignored, via `isSourceUnchangedSinceSync`).
 *      Remote callers (federation_health on the HTTP MCP path) read the stored
 *      `newest_content_at` column instead — NO git subprocess on a DB-supplied
 *      local_path (preserves the v0.41.27.0 trust boundary).
 */
import { execFileSync } from 'child_process';
import type { BrainEngine } from './engine.ts';
import { parseSourceConfig, type SourceRow } from './sources-load.ts';
import { isSourceUnchangedSinceSync } from './git-head.ts';

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
  /** v0.41.31: embed-backfill jobs specifically active right now. */
  backfill_active: number;
  /** v0.41.31: embed-backfill jobs queued (waiting/delayed/waiting-children). */
  backfill_queued: number;
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
 * Newest COMMIT timestamp for a source's checkout, in epoch ms, or `null` when
 * not determinable cheaply (non-git path, git unavailable, timeout). This is
 * the HEAD committer time (`git log -1 --format=%ct`) — NOT working-tree mtimes
 * (untracked/tracked-uncommitted files are not "committed content," and parsing
 * `git status --porcelain` for mtimes is fragile). Used at sync time to populate
 * the durable `sources.newest_content_at` column that the REMOTE staleness path
 * reads (so the HTTP MCP doctor never shells out to git).
 *
 * Fail-open: every error path returns `null`; the caller stores NULL and the
 * remote reader falls back to wall-clock. Shell-injection-safe (execFileSync
 * array args), matching the git-head.ts posture.
 */
export function newestCommitMs(localPath: string | null): number | null {
  if (!localPath) return null;
  try {
    const out = execFileSync('git', ['-C', localPath, 'log', '-1', '--format=%ct'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const ms = Number(out) * 1000;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null; // not a git repo / git unavailable / timeout
  }
}

/**
 * Committer time of a SPECIFIC commit SHA, in epoch ms, or `null` when not
 * determinable (non-git path, unknown/garbage sha, git unavailable, timeout).
 * Sibling of `newestCommitMs`, but pinned to an arbitrary commit instead of
 * HEAD — used by the resumable incremental sync (#1794) to stamp
 * `sources.newest_content_at` against the PINNED target commit the run drained
 * to, not whatever HEAD happens to be (HEAD may have moved past the pin via a
 * concurrent committer). For the pin == HEAD case this equals `newestCommitMs`.
 *
 * Fail-open: every error path returns `null`. Shell-injection-safe
 * (execFileSync array args), matching the `newestCommitMs` / git-head.ts posture.
 */
export function commitTimeMs(localPath: string | null, sha: string | null): number | null {
  if (!localPath || !sha) return null;
  try {
    const out = execFileSync('git', ['-C', localPath, 'show', '-s', '--format=%ct', sha], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    // `git show -s --format=%ct <sha>` prints only the committer epoch for the
    // resolved commit; take the first line in case the sha resolves to an
    // annotated-tag-ish ref that prints extra lines.
    const first = out.split('\n')[0]?.trim();
    const ms = Number(first) * 1000;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null; // not a git repo / unknown sha / git unavailable / timeout
  }
}

/**
 * Commit-relative lag in seconds from a STORED content timestamp (the
 * `newest_content_at` column), for REMOTE consumers that cannot shell out:
 *   - `null` when `lastSyncMs` is unknown.
 *   - Negative wall-clock (future `last_sync_at`) is surfaced as-is so upstream
 *     clock-skew detection still fires.
 *   - `0` when the stored content is at or before the last sync (caught up).
 *   - Wall-clock `now - lastSync` when content is newer, or when `contentMs` is
 *     null (no column value / pre-migration) — detection never regresses.
 *
 * Pure. The LOCAL path does NOT use this — it keys off the live commit hash via
 * `isSourceUnchangedSinceSync` (robust against HEAD moving to an old-dated
 * commit, which a timestamp comparison would miss).
 */
export function lagFromContentMs(
  contentMs: number | null,
  lastSyncMs: number | null,
  nowMs: number,
): number | null {
  if (lastSyncMs === null || !Number.isFinite(lastSyncMs)) return null;
  const wallClockSeconds = Math.floor((nowMs - lastSyncMs) / 1000);
  if (wallClockSeconds < 0) return wallClockSeconds; // clock skew passthrough
  if (contentMs !== null && Number.isFinite(contentMs)) {
    return contentMs <= lastSyncMs ? 0 : wallClockSeconds;
  }
  return wallClockSeconds; // no stored content signal — wall-clock fallback
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
  opts?: { probeContent?: boolean },
): Promise<SourceMetrics[]> {
  if (sources.length === 0) return [];

  const pageCounts = await pageCountsBySource(engine);
  const chunkCounts = await chunkCountsBySource(engine);
  const jobCounts = await jobCountsBySource(engine);
  const now = Date.now();
  // v0.41.32.0: LOCAL callers (gbrain sources status/audit) opt into a live
  // commit-hash probe; the REMOTE federation_health path leaves it off and
  // reads the stored column (no subprocess on a DB-supplied local_path).
  const probeContent = opts?.probeContent === true;

  return sources.map((src) => {
    const cfg = parseSourceConfig(src.config);
    const pages = pageCounts.get(src.id) ?? 0;
    const chunkStats = chunkCounts.get(src.id) ?? { total: 0, embedded: 0 };
    const jobStats = jobCounts.get(src.id) ?? { failed_24h: 0, queue_depth: 0, backfill_active: 0, backfill_queued: 0 };

    const embedCoverage = chunkStats.total === 0
      ? 100
      : Math.round((chunkStats.embedded / chunkStats.total) * 1000) / 10;

    const lastMs = src.last_sync_at ? new Date(src.last_sync_at).getTime() : null;
    // v0.41.32.0: commit-relative lag.
    //   LOCAL (probeContent): caught up iff HEAD == last_commit AND no tracked
    //     working-tree changes (untracked ignored) → lag 0; else wall-clock.
    //     Uses the live commit hash so a HEAD that moved to an old-dated commit
    //     is correctly NOT caught up. NULL last_commit → not caught up → wall-clock.
    //   REMOTE (default): read the stored newest_content_at column via
    //     lagFromContentMs — no git subprocess (v0.41.27.0 trust boundary).
    let lagSeconds: number | null;
    if (lastMs === null) {
      lagSeconds = null;
    } else if (probeContent) {
      const caughtUp = isSourceUnchangedSinceSync(src.local_path, src.last_commit, {
        requireCleanWorkingTree: 'ignore-untracked',
      });
      lagSeconds = caughtUp ? 0 : Math.max(0, Math.floor((now - lastMs) / 1000));
    } else {
      const contentMs = src.newest_content_at
        ? new Date(src.newest_content_at).getTime()
        : null;
      lagSeconds = lagFromContentMs(contentMs, lastMs, now);
    }

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
      backfill_active: jobStats.backfill_active,
      backfill_queued: jobStats.backfill_queued,
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

type JobStats = { failed_24h: number; queue_depth: number; backfill_active: number; backfill_queued: number };

async function jobCountsBySource(engine: BrainEngine): Promise<Map<string, JobStats>> {
  // Pre-v0.11 brains don't have minion_jobs; return empty map.
  try {
    const rows = await engine.executeRaw<{ source_id: string; failed_24h: number; queue_depth: number; backfill_active: number; backfill_queued: number }>(
      `SELECT data->>'sourceId' AS source_id,
              COUNT(*) FILTER (WHERE status IN ('failed','dead') AND created_at > NOW() - INTERVAL '24 hours')::int AS failed_24h,
              COUNT(*) FILTER (WHERE status IN ('waiting','active','delayed'))::int AS queue_depth,
              COUNT(*) FILTER (WHERE name = 'embed-backfill' AND status = 'active')::int AS backfill_active,
              COUNT(*) FILTER (WHERE name = 'embed-backfill' AND status IN ('waiting','delayed','waiting-children'))::int AS backfill_queued
         FROM minion_jobs
        WHERE name IN ('sync','embed-backfill')
          AND data->>'sourceId' IS NOT NULL
        GROUP BY data->>'sourceId'`,
    );
    const m = new Map<string, JobStats>();
    for (const r of rows) {
      m.set(r.source_id, {
        failed_24h: Number(r.failed_24h),
        queue_depth: Number(r.queue_depth),
        backfill_active: Number(r.backfill_active),
        backfill_queued: Number(r.backfill_queued),
      });
    }
    return m;
  } catch {
    return new Map();
  }
}
