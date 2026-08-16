/**
 * `gbrain status` — single-screen brain health dashboard.
 *
 * The command that answers "is my brain healthy and working?" without
 * making operators run five other commands (gbrain sources status, gbrain
 * stats, gbrain jobs supervisor status, gbrain jobs list, tail audit logs).
 *
 * Six sections:
 *   - Sync       — per-source last_sync_at + staleness
 *   - Cycle      — TWO rows: last FULL cycle (autopilot-cycle) +
 *                  last TARGETED run (any autopilot-* job). Reflects
 *                  v0.36.4.0's health-aware autopilot (healthy brains run
 *                  targeted handlers most ticks, full cycle every ~60min).
 *   - Locks      — active rows in gbrain_cycle_locks
 *   - Workers    — supervisor health from the audit JSONL
 *   - Queue      — live minion_jobs counts BY status (NO time window —
 *                  old stuck jobs are exactly what status surfaces)
 *   - Autopilot  — daemon PID liveness plus gbrain-autopilot identity probe
 *
 * Exit codes (kubectl-style):
 *   0  snapshot produced successfully (even if it carries warnings)
 *   1  snapshot could NOT be produced (DB unreachable, fatal IO error)
 *   2  usage error (bad --section value)
 *
 * Thin-client mode (isThinClient(cfg)):
 *   - Sync + Cycle + Workers + Queue route through `get_status_snapshot`
 *     MCP op (admin scope; workers/queue are snapshot-v2 sections — an old
 *     server that omits them renders a graceful "upgrade the remote" line)
 *   - Locks/Autopilot render "local-only — N/A on remote brain" because
 *     they're host-local concerns; pretending the local install's local-host
 *     operational state is the remote brain's would lie to the operator.
 *
 * --json emits a stable envelope:
 *   { schema_version: 1, sync, cycle, locks?, workers?, queue?, autopilot? }
 * Sections may be omitted (thin-client mode, --section filter, or
 * section-build failure that didn't break the whole snapshot).
 */

import type { BrainEngine } from '../core/engine.ts';
import { existsSync, readFileSync } from 'node:fs';
import { gbrainPath, loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import { VERSION } from '../version.ts';
import {
  classifyAutopilotLockHolder,
  type AutopilotLockProbeDeps,
} from '../core/autopilot-lock.ts';
import {
  buildSyncStatusReport,
  type SyncStatusReport,
} from './sync.ts';
import {
  readSupervisorEvents,
  summarizeCrashes,
} from '../core/minions/handlers/supervisor-audit.ts';

const SCHEMA_VERSION = 1 as const;

const VALID_SECTIONS = ['sync', 'cycle', 'locks', 'workers', 'queue', 'autopilot'] as const;
type Section = (typeof VALID_SECTIONS)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CycleRow {
  finished_at: string | null;
  name: string;
  status: string;
  duration_ms: number | null;
  totals: Record<string, unknown> | null;
}

export interface CycleSnapshot {
  /** Most recent fully-completed autopilot-cycle (9-phase full sweep). */
  last_full: CycleRow | null;
  /** Most recent autopilot-* job of any kind (full OR targeted). */
  last_targeted: CycleRow | null;
}

export interface LockRow {
  id: string;
  holder_pid: number | null;
  holder_host: string | null;
  acquired_at: string | null;
  ttl_expires_at: string | null;
}

export interface QueueCounts {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  dead: number;
}

/** Per-queue waiting depth + oldest-waiting age (snapshot v2 `queue.by_queue`). */
export interface QueueDepthRow {
  queue: string;
  depth: number;
  oldest_waiting_age_seconds: number | null;
}

/** Snapshot v2 `queue` section: status counts + per-queue waiting depths. */
export interface RemoteQueueSnapshot {
  counts: QueueCounts;
  by_queue: QueueDepthRow[];
}

/**
 * Snapshot v2 `workers` section — composed like `gbrain jobs supervisor
 * status` (pidfile first, queue-scoped DB singleton lock as the
 * HOME-independent fallback authority, #2227).
 */
export interface RemoteWorkersSnapshot {
  supervisor_alive: boolean;
  detected_via: 'pidfile' | 'db_lock' | null;
  live_lock_active: boolean;
  last_completed_at: string | null;
}

/**
 * Amendment 26: a snapshot v2 section that failed to compute degrades to this
 * marker instead of failing the whole snapshot.
 */
export interface SectionUnavailable {
  error: 'unavailable';
}

/**
 * Thin-client skew marker: the remote server predates snapshot v2 (missing
 * key / schema_version 1), so this section cannot be reported yet.
 */
export interface RemoteUnsupported {
  remote_unsupported: true;
}

export interface WorkerSummary {
  crashes_24h: number;
  clean_exits_24h: number;
  by_cause: Record<string, number>;
  last_event_ts: string | null;
}

export interface AutopilotStatus {
  installed: boolean;
  lockfile_present: boolean;
  pid: number | null;
  running: boolean;
}

export interface StatusReport {
  schema_version: typeof SCHEMA_VERSION;
  /** #1984: the local gbrain CLI version, so a poller can pin behavior to a build. */
  version: string;
  /** #1984: the remote brain server's version (thin-client only; present when reported). */
  remote_version?: string;
  generated_at: string;
  mode: 'local' | 'thin-client';
  sync?: SyncStatusReport;
  cycle?: CycleSnapshot;
  locks?: LockRow[] | { local_only_remote: true };
  workers?: WorkerSummary | RemoteWorkersSnapshot | SectionUnavailable | RemoteUnsupported | { local_only_remote: true };
  queue?: QueueCounts | RemoteQueueSnapshot | SectionUnavailable | RemoteUnsupported | { local_only_remote: true };
  autopilot?: AutopilotStatus | { local_only_remote: true };
  warnings?: string[];
  /** #1984: true when a --deadline-ms budget elided one or more sections. */
  partial?: boolean;
  /** #1984: names of the sections skipped/timed-out under the deadline. */
  stale_sections?: string[];
}

/**
 * #1984: race a section's work against the remaining deadline budget. Returns
 * the value, or undefined if the budget elapses first (the underlying query is
 * abandoned — the process is a one-shot, so a stranded read is fine). `ms`
 * undefined / <=0 means "no deadline" and the promise is awaited as-is.
 */
export async function withSectionDeadline<T>(
  p: Promise<T>,
  ms: number | undefined,
  onTimeout: () => void,
): Promise<T | undefined> {
  if (ms === undefined || ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => { onTimeout(); resolve(undefined); }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Cycle section — composable, also called from the MCP op
// ---------------------------------------------------------------------------

/**
 * Read the latest full cycle + latest targeted-run rows from `minion_jobs`.
 *
 * Read path is `result.report.totals` per codex MINOR-3 — the autopilot-cycle
 * handler returns `{partial, status, report}` where `report.totals` carries
 * the additive counters (synth_pages_written, patterns_written,
 * facts_consolidated, pages_emotional_weight_recomputed, …).
 *
 * Exported for `src/core/operations.ts:get_status_snapshot` and for the
 * E2E test fixture seed path.
 */
export async function buildCycleSnapshot(engine: BrainEngine): Promise<CycleSnapshot> {
  type Row = {
    finished_at: string | Date | null;
    name: string;
    status: string;
    started_at: string | Date | null;
    result: { partial?: unknown; status?: unknown; report?: { totals?: Record<string, unknown> } } | null;
  };

  const isoOrNull = (v: string | Date | null): string | null => {
    if (!v) return null;
    return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  };

  const durationMs = (started: string | Date | null, finished: string | Date | null): number | null => {
    if (!started || !finished) return null;
    const s = started instanceof Date ? started.getTime() : new Date(started).getTime();
    const f = finished instanceof Date ? finished.getTime() : new Date(finished).getTime();
    return Math.max(0, f - s);
  };

  const toCycleRow = (r: Row | undefined): CycleRow | null => {
    if (!r) return null;
    return {
      finished_at: isoOrNull(r.finished_at),
      name: r.name,
      status: r.status,
      duration_ms: durationMs(r.started_at, r.finished_at),
      totals: r.result?.report?.totals ?? null,
    };
  };

  let fullRow: Row | undefined;
  let targetedRow: Row | undefined;
  try {
    const fullRows = await engine.executeRaw<Row>(
      `SELECT finished_at, name, status, started_at, result
         FROM minion_jobs
        WHERE name = 'autopilot-cycle' AND status = 'completed'
        ORDER BY finished_at DESC NULLS LAST
        LIMIT 1`,
    );
    fullRow = fullRows[0];
  } catch {
    /* fall through — no row */
  }
  try {
    const targetedRows = await engine.executeRaw<Row>(
      `SELECT finished_at, name, status, started_at, result
         FROM minion_jobs
        WHERE name LIKE 'autopilot-%' AND status = 'completed'
        ORDER BY finished_at DESC NULLS LAST
        LIMIT 1`,
    );
    targetedRow = targetedRows[0];
  } catch {
    /* fall through */
  }
  return { last_full: toCycleRow(fullRow), last_targeted: toCycleRow(targetedRow) };
}

// ---------------------------------------------------------------------------
// Local-only sections
// ---------------------------------------------------------------------------

async function buildLocks(engine: BrainEngine): Promise<LockRow[]> {
  type Row = {
    id: string;
    holder_pid: number | null;
    holder_host: string | null;
    acquired_at: string | Date | null;
    ttl_expires_at: string | Date | null;
  };
  const iso = (v: string | Date | null) =>
    v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null;
  try {
    const rows = await engine.executeRaw<Row>(
      `SELECT id, holder_pid, holder_host, acquired_at, ttl_expires_at
         FROM gbrain_cycle_locks
        WHERE ttl_expires_at > NOW()
        ORDER BY acquired_at`,
    );
    return rows.map((r) => ({
      id: r.id,
      holder_pid: r.holder_pid,
      holder_host: r.holder_host,
      acquired_at: iso(r.acquired_at),
      ttl_expires_at: iso(r.ttl_expires_at),
    }));
  } catch {
    return [];
  }
}

// Exported for `src/core/operations.ts:get_status_snapshot` (snapshot v2 queue section).
export async function buildQueueCounts(engine: BrainEngine): Promise<QueueCounts> {
  type Row = { status: string; count: string | number };
  const counts: QueueCounts = { active: 0, waiting: 0, completed: 0, failed: 0, dead: 0 };
  try {
    // Live counts, NO time window (codex MAJOR-6). Old stuck waiting/active
    // jobs are the failure mode `gbrain status` should surface, not hide.
    const rows = await engine.executeRaw<Row>(
      `SELECT status, COUNT(*)::text AS count FROM minion_jobs GROUP BY status`,
    );
    for (const r of rows) {
      const n = typeof r.count === 'string' ? parseInt(r.count, 10) : r.count;
      if (r.status in counts) (counts as unknown as Record<string, number>)[r.status] = n;
    }
  } catch {
    /* PGLite without minion_jobs or pre-migration brain — return zeros */
  }
  return counts;
}

/**
 * Per-queue waiting depth + oldest-waiting age. Generalizes the doctor's
 * queue_health oldest-age SQL past its embed-backfill-only filter: EVERY
 * queue with waiting work reports here, name-agnostic. Perf note: WHERE
 * constrains only `status` — the SECOND column of the (queue, status,
 * updated_at) wedge index — so no prefix access exists and this GROUP BY
 * full-scans minion_jobs today. Acceptable at snapshot frequency over pruned
 * waiting sets; a partial (queue, created_at) WHERE status='waiting' index
 * is the fix if it becomes hot.
 */
export async function buildQueueDepths(engine: BrainEngine): Promise<QueueDepthRow[]> {
  const rows = await engine.executeRaw<{
    queue: string;
    depth: number | string;
    oldest_waiting_age_seconds: number | string | null;
  }>(
    `SELECT queue,
            count(*)::int AS depth,
            EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest_waiting_age_seconds
       FROM minion_jobs
      WHERE status = 'waiting'
      GROUP BY queue
      ORDER BY depth DESC`,
  );
  return rows.map((r) => ({
    queue: r.queue,
    depth: Number(r.depth),
    oldest_waiting_age_seconds:
      r.oldest_waiting_age_seconds === null ? null : Number(r.oldest_waiting_age_seconds),
  }));
}

/**
 * Snapshot v2 workers section. Same detection ladder as `gbrain jobs
 * supervisor status` (src/commands/jobs.ts): the pidfile is HOME-derived and
 * lies across split-$HOME deployments, so the queue-scoped DB singleton lock
 * (#1849/#2227) is probed as the fallback authority. `last_completed_at` is
 * the freshest completed-job timestamp — evidence a worker recently finished
 * something, regardless of how it was launched.
 *
 * `opts` exists as a test seam (scratch pidFile) — production callers take
 * the defaults.
 */
export async function buildWorkersSnapshot(
  engine: BrainEngine,
  opts: { pidFile?: string; queue?: string } = {},
): Promise<RemoteWorkersSnapshot> {
  const { readSupervisorPid } = await import('../core/minions/supervisor-pid.ts');
  const { DEFAULT_PID_FILE, supervisorLockId, SUPERVISOR_LOCK_TTL_MIN } = await import(
    '../core/minions/supervisor.ts'
  );
  const pidStatus = readSupervisorPid(opts.pidFile ?? DEFAULT_PID_FILE);

  let lockLive = false;
  try {
    const { inspectLock, isLockHolderLive } = await import('../core/db-lock.ts');
    const snap = await inspectLock(engine, supervisorLockId(opts.queue ?? 'default'));
    lockLive = snap !== null && isLockHolderLive(snap, SUPERVISOR_LOCK_TTL_MIN);
  } catch {
    /* pre-migration brains lack the locks table — pidfile signal stands */
  }

  let lastCompleted: string | null = null;
  try {
    const rows = await engine.executeRaw<{ last_completed: string | Date | null }>(
      `SELECT max(updated_at) AS last_completed FROM minion_jobs WHERE status = 'completed'`,
    );
    const v = rows[0]?.last_completed ?? null;
    lastCompleted = v ? (v instanceof Date ? v.toISOString() : new Date(v).toISOString()) : null;
  } catch {
    /* no minion_jobs table — leave null */
  }

  return {
    supervisor_alive: pidStatus.running || lockLive,
    detected_via: pidStatus.running ? 'pidfile' : lockLive ? 'db_lock' : null,
    live_lock_active: lockLive,
    last_completed_at: lastCompleted,
  };
}

function buildWorkerSummary(): WorkerSummary {
  let crashes_24h = 0;
  let clean_exits_24h = 0;
  const by_cause: Record<string, number> = {};
  let last_event_ts: string | null = null;
  try {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const events = readSupervisorEvents({ sinceMs: since });
    if (events.length > 0) {
      last_event_ts = events[events.length - 1].ts;
    }
    const exitEvents = events.filter((e) => e.event === 'worker_exited');
    const summary = summarizeCrashes(exitEvents);
    crashes_24h = summary.total;
    clean_exits_24h = summary.clean_exits;
    Object.assign(by_cause, summary.by_cause);
  } catch {
    /* audit dir missing or unreadable — return zeros */
  }
  return { crashes_24h, clean_exits_24h, by_cause, last_event_ts };
}

export function buildAutopilotStatus(
  lockPath: string = gbrainPath('autopilot.lock'),
  deps: AutopilotLockProbeDeps = {},
): AutopilotStatus {
  const lockfile_present = existsSync(lockPath);
  let pid: number | null = null;
  let running = false;
  if (lockfile_present) {
    try {
      const raw = readFileSync(lockPath, 'utf-8').trim();
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        pid = parsed;
        const holder = classifyAutopilotLockHolder(parsed, process.pid, deps);
        running = holder.state === 'alive-autopilot' || holder.state === 'alive-unknown';
      }
    } catch {
      /* unreadable lockfile, leave pid=null/running=false */
    }
  }
  return {
    installed: lockfile_present, // installed-or-running proxy; daemons writing the lock are installed
    lockfile_present,
    pid,
    running,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

interface BuildOpts {
  sections?: Set<Section>;
  /** #1984: total wall-clock budget; sections share it, later ones get the remainder. */
  deadlineMs?: number;
}

async function buildLocalReport(
  engine: BrainEngine,
  opts: BuildOpts,
): Promise<StatusReport> {
  const want = (s: Section) => !opts.sections || opts.sections.has(s);
  const warnings: string[] = [];
  const staleSections: string[] = [];
  const report: StatusReport = {
    schema_version: SCHEMA_VERSION,
    version: VERSION,
    generated_at: new Date().toISOString(),
    mode: 'local',
  };

  // #1984: a shared budget so `gbrain status --deadline-ms=N` never blocks a
  // poller past N. Each async section is raced against the REMAINING budget, so
  // one slow/hung section (cross-region DB, lock contention) can't strand the
  // whole snapshot — it's marked stale and the rest still return.
  const deadlineAt = opts.deadlineMs && opts.deadlineMs > 0 ? Date.now() + opts.deadlineMs : null;
  const remaining = (): number | undefined =>
    deadlineAt === null ? undefined : Math.max(1, deadlineAt - Date.now());
  const markStale = (name: Section) => {
    staleSections.push(name);
    report.partial = true;
    warnings.push(`${name} section exceeded the --deadline-ms budget (returned stale)`);
  };

  if (want('sync')) {
    try {
      report.sync = await withSectionDeadline(
        (async () => {
          const sources = await engine.executeRaw<{
            id: string;
            name: string;
            local_path: string | null;
            config: Record<string, unknown> | null;
          }>(`SELECT id, name, local_path, config FROM sources ORDER BY id`);
          return buildSyncStatusReport(
            engine,
            sources.map((s) => ({ id: s.id, name: s.name, local_path: s.local_path, config: s.config ?? {} })),
          );
        })(),
        remaining(),
        () => markStale('sync'),
      );
    } catch (err) {
      warnings.push(`sync section failed: ${(err as Error).message}`);
    }
  }
  if (want('cycle')) {
    try {
      report.cycle = await withSectionDeadline(buildCycleSnapshot(engine), remaining(), () => markStale('cycle'));
    } catch (err) {
      warnings.push(`cycle section failed: ${(err as Error).message}`);
    }
  }
  if (want('locks')) {
    report.locks = await withSectionDeadline(buildLocks(engine), remaining(), () => markStale('locks'));
  }
  if (want('workers')) {
    report.workers = buildWorkerSummary();
  }
  if (want('queue')) {
    report.queue = await withSectionDeadline(buildQueueCounts(engine), remaining(), () => markStale('queue'));
  }
  if (want('autopilot')) {
    report.autopilot = buildAutopilotStatus();
  }
  if (staleSections.length > 0) report.stale_sections = staleSections;
  if (warnings.length > 0) report.warnings = warnings;
  return report;
}

async function buildThinClientReport(
  cfg: ReturnType<typeof loadConfig>,
  opts: BuildOpts,
): Promise<StatusReport> {
  const want = (s: Section) => !opts.sections || opts.sections.has(s);
  const warnings: string[] = [];
  const report: StatusReport = {
    schema_version: SCHEMA_VERSION,
    version: VERSION,
    generated_at: new Date().toISOString(),
    mode: 'thin-client',
  };

  // Snapshot v2 also backs workers + queue (locks/autopilot stay host-local).
  const remoteBacked: Section[] = ['sync', 'cycle', 'workers', 'queue'];
  if (remoteBacked.some((s) => want(s))) {
    try {
      const payload = await withSectionDeadline(
        (async () => {
          // #1984: pass the budget as the request timeout so the LOSING side of
          // the race actually cancels the in-flight MCP call instead of leaking
          // it (the section deadline only abandons the promise locally).
          const raw = await callRemoteTool(
            cfg!,
            'get_status_snapshot',
            {},
            opts.deadlineMs && opts.deadlineMs > 0 ? { timeoutMs: opts.deadlineMs } : {},
          );
          return unpackToolResult<RemoteSnapshotPayload>(raw);
        })(),
        opts.deadlineMs && opts.deadlineMs > 0 ? opts.deadlineMs : undefined,
        () => {
          report.partial = true;
          // Only name the sections the caller actually requested; the remote
          // fetch backs sync+cycle+workers+queue, but `--section sync` must not
          // report a section it excluded as stale. Matches the local path.
          const elided = remoteBacked.filter((s) => want(s));
          report.stale_sections = [...(report.stale_sections ?? []), ...elided];
          warnings.push('remote snapshot exceeded the --deadline-ms budget (returned stale)');
        },
      );
      if (payload) applyRemoteSnapshot(report, payload, want);
    } catch (err) {
      warnings.push(`remote snapshot failed: ${(err as Error).message}`);
    }
  }
  if (want('locks')) report.locks = { local_only_remote: true };
  if (want('autopilot')) report.autopilot = { local_only_remote: true };
  if (warnings.length > 0) report.warnings = warnings;
  return report;
}

/** Wire shape of the `get_status_snapshot` payload across server versions. */
export interface RemoteSnapshotPayload {
  schema_version: number;
  version?: string;
  sync: SyncStatusReport;
  cycle: CycleSnapshot;
  /** v2+ — absent on schema_version-1 servers. */
  workers?: RemoteWorkersSnapshot | SectionUnavailable;
  /** v2+ — absent on schema_version-1 servers. */
  queue?: RemoteQueueSnapshot | SectionUnavailable;
}

/**
 * Map a remote snapshot payload onto the thin-client report. Exported for the
 * skew fixture test: a NEW thin-client against an OLD (schema_version 1)
 * server must degrade the v2-only sections to a graceful marker, never crash
 * or pretend local data is remote data.
 */
export function applyRemoteSnapshot(
  report: StatusReport,
  payload: RemoteSnapshotPayload,
  want: (s: Section) => boolean,
): void {
  // #1984: surface the brain server's version for thin-client parity.
  if (payload.version) report.remote_version = payload.version;
  if (want('sync')) report.sync = payload.sync;
  if (want('cycle')) report.cycle = payload.cycle;
  // v2 sections: an old server omits the keys entirely (schema_version 1) —
  // degrade to the skew marker rather than the misleading "N/A on remote".
  if (want('workers')) report.workers = payload.workers ?? { remote_unsupported: true };
  if (want('queue')) report.queue = payload.queue ?? { remote_unsupported: true };
}

// ---------------------------------------------------------------------------
// Human render
// ---------------------------------------------------------------------------

// Exported for the thin-client skew fixture test (old-server payload render).
export function renderHuman(report: StatusReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('GBrain Status');
  lines.push('=============');
  const ver = report.remote_version && report.remote_version !== report.version
    ? `v${report.version} (remote v${report.remote_version})`
    : `v${report.version}`;
  lines.push(`Mode: ${report.mode}  ·  ${ver}  ·  ${report.generated_at}`);
  if (report.partial) {
    lines.push(`⚠ partial snapshot — stale sections: ${(report.stale_sections ?? []).join(', ')} (--deadline-ms budget hit)`);
  }
  lines.push('');

  // Sync
  if (report.sync) {
    lines.push('Sync:');
    if (report.sync.sources.length === 0) {
      lines.push('  (no sources registered)');
    } else {
      for (const s of report.sync.sources) {
        const last = s.last_sync_at ?? 'never';
        const stale = s.staleness_class === 'fresh' ? 'OK' : s.staleness_class.toUpperCase();
        lines.push(
          `  [${stale}] ${s.source_id.padEnd(20)} ${last}  pages=${s.pages}  ` +
            `embed=${s.embedding_coverage_pct.toFixed(0)}%`,
        );
      }
      if (report.sync.unacknowledged_failures > 0) {
        lines.push(`  ${report.sync.unacknowledged_failures} unacknowledged sync failure(s)`);
      }
    }
    lines.push('');
  }

  // Cycle
  if (report.cycle) {
    lines.push('Cycle:');
    const fmt = (row: CycleRow | null, label: string) => {
      if (!row) return `  ${label}: never run`;
      const dur = row.duration_ms != null ? ` (${(row.duration_ms / 1000).toFixed(1)}s)` : '';
      const totalsStr = row.totals && Object.keys(row.totals).length > 0
        ? `  totals=${JSON.stringify(row.totals)}`
        : '';
      return `  ${label}: ${row.finished_at}${dur}${totalsStr}`;
    };
    lines.push(fmt(report.cycle.last_full, 'Last full cycle'));
    lines.push(fmt(report.cycle.last_targeted, 'Last targeted run'));
    lines.push('');
  }

  // Locks
  if (report.locks) {
    lines.push('Locks:');
    if ('local_only_remote' in report.locks) {
      lines.push('  local-only — N/A on remote brain');
    } else if (report.locks.length === 0) {
      lines.push('  (none active)');
    } else {
      for (const l of report.locks) {
        lines.push(
          `  ${l.id.padEnd(28)} pid=${l.holder_pid ?? '?'}  expires=${l.ttl_expires_at ?? '?'}`,
        );
      }
    }
    lines.push('');
  }

  // Workers
  if (report.workers) {
    lines.push('Workers (last 24h):');
    if ('local_only_remote' in report.workers) {
      lines.push('  local-only — N/A on remote brain');
    } else if ('remote_unsupported' in report.workers) {
      lines.push('  not reported by this brain server (predates snapshot v2) — upgrade the remote gbrain to see workers');
    } else if ('error' in report.workers) {
      lines.push('  unavailable (remote section failed to compute)');
    } else if ('supervisor_alive' in report.workers) {
      const w = report.workers;
      const via = w.detected_via ? ` (via ${w.detected_via})` : '';
      lines.push(`  supervisor: ${w.supervisor_alive ? 'alive' : 'not detected'}${via}  db_lock=${w.live_lock_active ? 'live' : 'none'}`);
      lines.push(`  last completed job: ${w.last_completed_at ?? 'never'}`);
    } else {
      const w = report.workers;
      lines.push(`  crashes=${w.crashes_24h}  clean_exits=${w.clean_exits_24h}`);
      const causes = Object.entries(w.by_cause).filter(([, n]) => n > 0);
      if (causes.length > 0) {
        lines.push(`  by_cause: ${causes.map(([k, v]) => `${k}=${v}`).join(', ')}`);
      }
      if (w.last_event_ts) lines.push(`  last event: ${w.last_event_ts}`);
    }
    lines.push('');
  }

  // Queue
  if (report.queue) {
    lines.push('Queue (live):');
    if ('local_only_remote' in report.queue) {
      lines.push('  local-only — N/A on remote brain');
    } else if ('remote_unsupported' in report.queue) {
      lines.push('  not reported by this brain server (predates snapshot v2) — upgrade the remote gbrain to see queue depth');
    } else if ('error' in report.queue) {
      lines.push('  unavailable (remote section failed to compute)');
    } else if ('counts' in report.queue) {
      const q = report.queue.counts;
      lines.push(
        `  active=${q.active}  waiting=${q.waiting}  failed=${q.failed}  dead=${q.dead}  completed=${q.completed}`,
      );
      for (const row of report.queue.by_queue) {
        const age = row.oldest_waiting_age_seconds != null
          ? `  oldest_waiting=${Math.round(row.oldest_waiting_age_seconds / 60)}m`
          : '';
        lines.push(`  [${row.queue}] depth=${row.depth}${age}`);
      }
    } else {
      const q = report.queue;
      lines.push(
        `  active=${q.active}  waiting=${q.waiting}  failed=${q.failed}  dead=${q.dead}  completed=${q.completed}`,
      );
    }
    lines.push('');
  }

  // Autopilot
  if (report.autopilot) {
    lines.push('Autopilot:');
    if ('local_only_remote' in report.autopilot) {
      lines.push('  local-only — N/A on remote brain');
    } else {
      const a = report.autopilot;
      if (a.running) {
        lines.push(`  running (PID ${a.pid})`);
      } else if (a.lockfile_present) {
        lines.push(`  stale lockfile (PID ${a.pid ?? '?'} is not a live autopilot process). Run \`gbrain autopilot --install\` to restart.`);
      } else {
        lines.push('  not running. Install with `gbrain autopilot --install`.');
      }
    }
    lines.push('');
  }

  // Warnings
  if (report.warnings && report.warnings.length > 0) {
    lines.push('Warnings:');
    for (const w of report.warnings) lines.push(`  ! ${w}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/**
 * Parse `--section <name>` (and `--section=<name>` form) from args.
 * Returns:
 *   - undefined → no filter (all sections)
 *   - Set<Section> → only these sections
 *   - 'usage_error' → bad section name (caller exits 2)
 */
/** #1984: `--fast` preset budget (ms) when no explicit `--deadline-ms` is given. */
export const FAST_DEADLINE_MS = 2000;

/**
 * #1984: parse the status deadline budget. `--deadline-ms=N` (or `--deadline-ms N`)
 * wins; bare `--fast` applies FAST_DEADLINE_MS. Returns undefined (no budget),
 * a positive ms value, or 'usage_error' on a non-positive / non-numeric value.
 */
export function parseDeadlineFlag(args: string[]): number | undefined | 'usage_error' {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--deadline-ms') {
      // #1984: a bare `--deadline-ms` with no following value is a usage error,
      // not a silent fall-through to no-budget / --fast (which would mask a
      // typo'd budget and let a poller hang it never meant to).
      if (i + 1 >= args.length) return 'usage_error';
      raw = args[i + 1];
      break;
    }
    if (a.startsWith('--deadline-ms=')) { raw = a.slice('--deadline-ms='.length); break; }
  }
  if (raw == null) {
    return args.includes('--fast') ? FAST_DEADLINE_MS : undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 'usage_error';
  return n;
}

export function parseSectionFlag(args: string[]): Set<Section> | undefined | 'usage_error' {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--section' && i + 1 < args.length) {
      raw = args[i + 1];
      break;
    }
    if (a.startsWith('--section=')) {
      raw = a.slice('--section='.length);
      break;
    }
  }
  if (raw == null) return undefined;
  if (!VALID_SECTIONS.includes(raw as Section)) return 'usage_error';
  return new Set<Section>([raw as Section]);
}

export interface RunStatusResult {
  exitCode: 0 | 1 | 2;
  report?: StatusReport;
}

/**
 * Programmatic entry. `cli.ts` calls this; tests can drive it directly.
 *
 * Engine is nullable so the thin-client path doesn't require a connected
 * engine (matches the v0.31.1 `runThinClientRouted` posture in cli.ts).
 */
export async function runStatus(
  engine: BrainEngine | null,
  args: string[],
  opts: { stdout?: (s: string) => void; stderr?: (s: string) => void } = {},
): Promise<RunStatusResult> {
  const stdout = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));

  const sectionFlag = parseSectionFlag(args);
  if (sectionFlag === 'usage_error') {
    stderr(
      `gbrain status: invalid --section. Valid: ${VALID_SECTIONS.join('|')}\n`,
    );
    return { exitCode: 2 };
  }
  const sections = sectionFlag;
  const json = args.includes('--json');

  const deadlineMs = parseDeadlineFlag(args);
  if (deadlineMs === 'usage_error') {
    stderr('gbrain status: --deadline-ms must be a positive number of milliseconds\n');
    return { exitCode: 2 };
  }

  const cfg = loadConfig();
  const useThinClient = cfg ? isThinClient(cfg) : false;

  let report: StatusReport;
  try {
    if (useThinClient) {
      report = await buildThinClientReport(cfg, { sections, deadlineMs });
    } else {
      if (!engine) {
        stderr('gbrain status: no engine connected (DB unreachable?). Run `gbrain doctor` to diagnose.\n');
        return { exitCode: 1 };
      }
      report = await buildLocalReport(engine, { sections, deadlineMs });
    }
  } catch (err) {
    stderr(`gbrain status: snapshot failed: ${(err as Error).message}\n`);
    return { exitCode: 1 };
  }

  if (json) {
    stdout(JSON.stringify(report) + '\n');
  } else {
    stdout(renderHuman(report));
  }

  return { exitCode: 0, report };
}
