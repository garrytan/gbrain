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
 *      last_commit, via `probeSourceGitState`).
 *      Remote callers (federation_health on the HTTP MCP path) read the stored
 *      `newest_content_at` column instead — NO git subprocess on a DB-supplied
 *      local_path (preserves the v0.41.27.0 trust boundary).
 *
 * GBRA-133 PR 2b.5: the local probe compares HEAD only (an uncommitted edit
 *      to a tracked file is not a pending commit), and a source that is behind
 *      dates its lag from when the commit landed (the reflog entry that moved
 *      HEAD off last_commit) or from the commit notifier's persisted
 *      first_due_at, not from the last no-op heartbeat of last_sync_at. Both
 *      paths raise the lag to first_due_at's age (src/core/sync-pending.ts).
 */
import { execFileSync } from './spawn.ts';
import { execFileBounded } from './bounded-child-exec.ts';
import type { BrainEngine } from './engine.ts';
import { parseSourceConfig, type SourceRow } from './sources-load.ts';
import { probeSourceGitState } from './git-head.ts';
import { resolveHoursEnv } from './env-number.ts';
import { isSyncDisabledConfig } from './sync-policy.ts';
import { gitChildEnv } from './git-env.ts';

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
      env: gitChildEnv(),
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
    return parseCommitTime(execFileSync('git', ['-C', localPath, 'show', '-s', '--format=%ct', sha], {
      env: gitChildEnv(),
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch {
    return null; // not a git repo / unknown sha / git unavailable / timeout
  }
}

/** GBRA-133 2b.3: `commitTimeMs` without blocking the event loop (the classic sync's anchor write in a resident). */
export async function commitTimeMsAsync(localPath: string | null, sha: string | null): Promise<number | null> {
  if (!localPath || !sha) return null;
  const r = await execFileBounded('git', ['-C', localPath, 'show', '-s', '--format=%ct', sha], { env: gitChildEnv(), timeout: 10_000 });
  return r.error ? null : parseCommitTime(r.stdout);
}

function parseCommitTime(stdout: string): number | null {
  const out = stdout.trim();
  if (!out) return null;
  // `git show -s --format=%ct <sha>` prints only the committer epoch for the
  // resolved commit; take the first line in case the sha resolves to an
  // annotated-tag-ish ref that prints extra lines.
  const first = out.split('\n')[0]?.trim();
  const ms = Number(first) * 1000;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Resolve the staleness-ceiling in seconds.
 *
 * `GBRAIN_STALENESS_CEILING_HOURS` overrides; otherwise it tracks
 * `GBRAIN_SYNC_FRESHNESS_FAIL_HOURS` (default 72) so the ceiling and the check
 * that reads it cannot drift apart by default, while still being separable
 * during an incident.
 */
export function resolveStalenessCeilingSeconds(): number {
  const base = resolveHoursEnv('GBRAIN_SYNC_FRESHNESS_FAIL_HOURS', 72);
  return Math.floor(resolveHoursEnv('GBRAIN_STALENESS_CEILING_HOURS', base) * 3600);
}

/**
 * Commit-relative lag in seconds from a STORED content timestamp (the
 * `newest_content_at` column), for consumers that cannot shell out:
 *   - `null` when `lastSyncMs` is unknown.
 *   - Negative wall-clock (future `last_sync_at`) is surfaced as-is so upstream
 *     clock-skew detection still fires.
 *   - Caught up (content at or before the last sync) → `0` UNTIL wall-clock
 *     passes the ceiling, then a monotonic ramp (see below).
 *   - Wall-clock `now - lastSync` when content is newer, or when `contentMs` is
 *     null (no column value / pre-migration) — detection never regresses.
 *
 * The core logic is pure; only the DEFAULT `ceilingSeconds` reads env. Callers
 * that need determinism pass the ceiling explicitly.
 *
 * WHY THE RAMP (the 71-day bug):
 *
 *   Before, "caught up" returned a hard 0 forever, so a source whose clone had
 *   vanished reported fresh indefinitely — the wall-clock number was computed on
 *   the line above and thrown away. But the caught-up branch is not a mistake: it
 *   exists (see `checkSyncFreshness`'s clone-unavailable path) because a
 *   container restart wipes `local_path`, and every QUIET source would otherwise
 *   read stale after a restart. That justification assumed a no-op sync does not
 *   advance `last_sync_at`, which stopped being true in v0.42.52.0 — a 0-change
 *   sync now heartbeats the column. So a quiet source that is genuinely being
 *   checked has a RECENT `last_sync_at` and stays at 0; only a source nobody has
 *   looked at in a very long time crosses the ceiling.
 *
 *   It ramps rather than steps because three consumers read this one value at
 *   different thresholds: `federation_health` fails at 24h, `sync_freshness`
 *   warns at 24h / fails at 72h, and `buildSyncStatusReport` buckets at a
 *   hardcoded 24/72. A step to the ceiling would cross all of them in the same
 *   instant, firing two checks at once and skipping the warn tier entirely —
 *   which is the alert-storm shape the caught-up branch was written to prevent.
 *   `max(0, wallClock - ceiling)` grows continuously, so warn still precedes
 *   fail and the surfaces escalate in order.
 *
 * The LOCAL path does NOT use this — it keys off the live commit hash via
 * `probeSourceGitState` (robust against HEAD moving to an old-dated
 * commit, which a timestamp comparison would miss).
 */
export function lagFromContentMs(
  contentMs: number | null,
  lastSyncMs: number | null,
  nowMs: number,
  ceilingSeconds: number = resolveStalenessCeilingSeconds(),
): number | null {
  if (lastSyncMs === null || !Number.isFinite(lastSyncMs)) return null;
  const wallClockSeconds = Math.floor((nowMs - lastSyncMs) / 1000);
  if (wallClockSeconds < 0) return wallClockSeconds; // clock skew passthrough
  if (contentMs !== null && Number.isFinite(contentMs)) {
    // Caught up: 0 while recently checked, then ramp once nobody has looked
    // for longer than the ceiling.
    return contentMs <= lastSyncMs
      ? Math.max(0, wallClockSeconds - ceilingSeconds)
      : wallClockSeconds;
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
  // One ceiling for the whole report (hoisted out of the per-source map):
  // every source gets the same number, and the env read runs once.
  const stalenessCeilingSeconds = resolveStalenessCeilingSeconds();
  // GBRA-133 PR 2b.5: the commit notifier's persisted first_due_at dates a pending commit on both paths (no git).
  const { readFirstDue, readGitPendingEvidence } = await import('./sync-pending.ts');
  const firstDue = await readFirstDue(engine, sources.map((src) => src.id)).catch(() => new Map<string, { firstDueAt: number | null }>());

  return Promise.all(sources.map(async (src) => {
    const cfg = parseSourceConfig(src.config);
    const pages = pageCounts.get(src.id) ?? 0;
    const chunkStats = chunkCounts.get(src.id) ?? { total: 0, embedded: 0 };
    const jobStats = jobCounts.get(src.id) ?? { failed_24h: 0, queue_depth: 0, backfill_active: 0, backfill_queued: 0 };

    const embedCoverage = chunkStats.total === 0
      ? 100
      : Math.round((chunkStats.embedded / chunkStats.total) * 1000) / 10;

    const lastMs = src.last_sync_at ? new Date(src.last_sync_at).getTime() : null;
    const dueMs = firstDue.get(src.id)?.firstDueAt ?? null;
    // v0.41.32.0: commit-relative lag. TWO implementations, and the split is
    // load-bearing rather than accidental duplication — see the diagram.
    //
    //   computeAllSourceMetrics
    //         │
    //         ├─ probeContent: true  ──► probeSourceGitState, HEAD only (git subprocess)
    //         │                          LOCAL only. Accurate: keys off the live
    //         │                          commit hash, so a HEAD moved to an
    //         │                          old-dated commit is correctly NOT caught
    //         │                          up, and an uncommitted edit is not a
    //         │                          pending commit. Behind: lag runs from the
    //         │                          reflog entry that moved HEAD off
    //         │                          last_commit, else the notifier's
    //         │                          first_due_at, else wall-clock since the
    //         │                          last sync. Caller: `gbrain sources status`.
    //         │
    //         └─ probeContent: false ──► lagFromContentMs (column read)
    //                                    REMOTE-SAFE: no subprocess, because a
    //                                    remote-callable path must never shell
    //                                    out against a DB-supplied local_path
    //                                    (v0.41.27.0 trust boundary). That makes
    //                                    it structurally less accurate than the
    //                                    probe, which is exactly why it needs the
    //                                    staleness ceiling to stay honest.
    //                                    Callers: doctor `federation_health`,
    //                                    doctor `sync_freshness` (via its own
    //                                    clone-unavailable branch), and
    //                                    `buildSyncStatusReport` (gbrain status).
    //                                    A persisted first_due_at raises it to
    //                                    the time the commit has been due.
    //
    // Do NOT "unify" these behind one flag: collapsing the trust boundary into a
    // boolean is how a remote caller eventually acquires a subprocess.
    let lagSeconds: number | null;
    if (lastMs === null) {
      lagSeconds = null;
    } else if (probeContent) {
      const state = probeSourceGitState(src.local_path, src.last_commit);
      const evidence = state === 'changed' && src.local_path && src.last_commit
        ? await readGitPendingEvidence(src.local_path, src.last_commit).catch(() => null)
        : null;
      const sinceMs = evidence?.departedAt != null ? evidence.departedAt * 1000 : dueMs;
      lagSeconds = state === 'unchanged' ? 0 : Math.max(0, Math.floor((now - (sinceMs ?? lastMs)) / 1000));
    } else {
      const contentMs = src.newest_content_at
        ? new Date(src.newest_content_at).getTime()
        : null;
      lagSeconds = lagFromContentMs(contentMs, lastMs, now, stalenessCeilingSeconds);
      if (lagSeconds !== null && lagSeconds >= 0 && dueMs !== null) lagSeconds = Math.max(lagSeconds, Math.floor((now - dueMs) / 1000));
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
  }));
}

async function pageCountsBySource(engine: BrainEngine): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  for (const r of await engine.countLivePagesBySource()) m.set(r.source_id, Number(r.n));
  return m;
}

async function chunkCountsBySource(engine: BrainEngine): Promise<Map<string, { total: number; embedded: number }>> {
  // Coverage must count the ACTIVE embedding column: a registry-routed brain
  // (search_embedding_column != 'embedding') writes vectors elsewhere, and
  // keying the literal legacy column here read 0% forever — a permanently-red
  // doctor check recommending no-op remediations. Fail open to legacy.
  const { resolveActiveEmbeddingColumnFromEngine } = await import('./search/embedding-column.ts');
  const active = await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true });
  const m = new Map<string, { total: number; embedded: number }>();
  for (const r of await engine.countChunksBySource(active.name)) m.set(r.source_id, { total: Number(r.total), embedded: Number(r.embedded) });
  return m;
}

type JobStats = { failed_24h: number; queue_depth: number; backfill_active: number; backfill_queued: number };

async function jobCountsBySource(engine: BrainEngine): Promise<Map<string, JobStats>> {
  // Pre-v0.11 brains don't have minion_jobs; return empty map.
  try {
    const rows = await engine.readSourceJobCounts(86400);
    const m = new Map<string, JobStats>();
    for (const r of rows) {
      m.set(r.source_id, {
        failed_24h: r.failed_24h,
        queue_depth: r.queue_depth,
        backfill_active: r.backfill_active,
        backfill_queued: r.backfill_queued,
      });
    }
    return m;
  } catch {
    return new Map();
  }
}

/**
 * Sync-eligible sources with a local path, for doctor `sync_freshness`,
 * including the upstream observation sync records (#5255, O-DX-8). Older
 * brains without those columns (or without `archived`) still load.
 * `sourceIds` (a remote caller's grant) confines the roster in SQL.
 */
export async function loadSyncFreshnessSources(engine: BrainEngine, sourceIds?: string[]) {
  type FreshnessSourceRow = {
    id: string;
    name: string;
    local_path: string | null;
    last_sync_at: Date | null;
    last_commit: string | null;
    chunker_version: string | null;
    newest_content_at: Date | null;
    config: unknown;
    upstream_checked_at: Date | null;
    upstream_commit: string | null;
    upstream_behind: number | null;
  };
  const sources: FreshnessSourceRow[] = await engine.readDoctorSources('freshness', { sourceIds });
  return sources.filter((source) => !isSyncDisabledConfig(source.config));
}
