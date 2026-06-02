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
 *   - Autopilot  — daemon PID liveness via kill -0 probe
 *
 * Exit codes (kubectl-style):
 *   0  snapshot produced successfully (even if it carries warnings)
 *   1  snapshot could NOT be produced (DB unreachable, fatal IO error)
 *   2  usage error (bad --section value)
 *
 * Thin-client mode (isThinClient(cfg)):
 *   - Sync + Cycle route through `get_status_snapshot` MCP op (admin scope)
 *   - Locks/Workers/Queue/Autopilot render "local-only — N/A on remote brain"
 *     because they're host-local concerns; pretending the local install's
 *     local-host operational state is the remote brain's would lie to the
 *     operator.
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
  generated_at: string;
  mode: 'local' | 'thin-client';
  sync?: SyncStatusReport;
  cycle?: CycleSnapshot;
  locks?: LockRow[] | { local_only_remote: true };
  workers?: WorkerSummary | { local_only_remote: true };
  queue?: QueueCounts | { local_only_remote: true };
  autopilot?: AutopilotStatus | { local_only_remote: true };
  warnings?: string[];
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

async function buildQueueCounts(engine: BrainEngine): Promise<QueueCounts> {
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

function buildAutopilotStatus(): AutopilotStatus {
  const lockPath = gbrainPath('autopilot.lock');
  const lockfile_present = existsSync(lockPath);
  let pid: number | null = null;
  let running = false;
  if (lockfile_present) {
    try {
      const raw = readFileSync(lockPath, 'utf-8').trim();
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        pid = parsed;
        try {
          // kill -0 probes liveness without sending a real signal. Throws ESRCH
          // if the PID is gone, EPERM if alive but owned by another user (which
          // still tells us "something with that PID exists").
          process.kill(parsed, 0);
          running = true;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          running = code === 'EPERM';
        }
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
}

async function buildLocalReport(
  engine: BrainEngine,
  opts: BuildOpts,
): Promise<StatusReport> {
  const want = (s: Section) => !opts.sections || opts.sections.has(s);
  const warnings: string[] = [];
  const report: StatusReport = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    mode: 'local',
  };

  if (want('sync')) {
    try {
      const sources = await engine.executeRaw<{
        id: string;
        name: string;
        local_path: string | null;
        config: Record<string, unknown> | null;
      }>(`SELECT id, name, local_path, config FROM sources ORDER BY id`);
      report.sync = await buildSyncStatusReport(
        engine,
        sources.map((s) => ({ id: s.id, name: s.name, local_path: s.local_path, config: s.config ?? {} })),
      );
    } catch (err) {
      warnings.push(`sync section failed: ${(err as Error).message}`);
    }
  }
  if (want('cycle')) {
    try {
      report.cycle = await buildCycleSnapshot(engine);
    } catch (err) {
      warnings.push(`cycle section failed: ${(err as Error).message}`);
    }
  }
  if (want('locks')) {
    report.locks = await buildLocks(engine);
  }
  if (want('workers')) {
    report.workers = buildWorkerSummary();
  }
  if (want('queue')) {
    report.queue = await buildQueueCounts(engine);
  }
  if (want('autopilot')) {
    report.autopilot = buildAutopilotStatus();
  }
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
    generated_at: new Date().toISOString(),
    mode: 'thin-client',
  };

  if (want('sync') || want('cycle')) {
    try {
      const raw = await callRemoteTool(cfg!, 'get_status_snapshot', {});
      const payload = unpackToolResult<{
        schema_version: number;
        sync: SyncStatusReport;
        cycle: CycleSnapshot;
      }>(raw);
      if (want('sync')) report.sync = payload.sync;
      if (want('cycle')) report.cycle = payload.cycle;
    } catch (err) {
      warnings.push(`remote snapshot failed: ${(err as Error).message}`);
    }
  }
  if (want('locks')) report.locks = { local_only_remote: true };
  if (want('workers')) report.workers = { local_only_remote: true };
  if (want('queue')) report.queue = { local_only_remote: true };
  if (want('autopilot')) report.autopilot = { local_only_remote: true };
  if (warnings.length > 0) report.warnings = warnings;
  return report;
}

// ---------------------------------------------------------------------------
// Human render
// ---------------------------------------------------------------------------

function renderHuman(report: StatusReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('GBrain Status');
  lines.push('=============');
  lines.push(`Mode: ${report.mode}  ·  ${report.generated_at}`);
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
        lines.push(`  stale lockfile (PID ${a.pid ?? '?'} not alive). Run \`gbrain autopilot --install\` to restart.`);
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

  const cfg = loadConfig();
  const useThinClient = cfg ? isThinClient(cfg) : false;

  let report: StatusReport;
  try {
    if (useThinClient) {
      report = await buildThinClientReport(cfg, { sections });
    } else {
      if (!engine) {
        stderr('gbrain status: no engine connected (DB unreachable?). Run `gbrain doctor` to diagnose.\n');
        return { exitCode: 1 };
      }
      report = await buildLocalReport(engine, { sections });
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
