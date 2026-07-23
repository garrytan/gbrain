/**
 * v0.41 D2 — `gbrain jobs watch` live TTY dashboard.
 *
 * Submit and supervise instead of submit and pray. Shows throughput,
 * current rate-lease utilization, top errors clustered by error-classify,
 * and budget remaining (when a `--budget-usd` parent is in flight).
 *
 * Refresh tick: 1s (intentionally conservative — operators don't need
 * 60fps; 1s keeps the SQL load nominal even when multiple watch sessions
 * point at the same brain).
 *
 * Two independent axes (v0.42.11.0, #1784 — decoupled from `isTTY`):
 *   - FORMAT (what data prints): human by default, JSON only when `--json` is
 *     passed. NEVER gated on isTTY.
 *   - LOOP (cadence): `--follow` streams continuously; default is `isTTY` —
 *     continuous live dashboard in a terminal, ONE snapshot then exit when
 *     non-TTY (pipe / cron / subagent). Identical data either way, so defaulting
 *     the loop from isTTY is a cosmetic UX call, not a data gate.
 *
 * Resulting matrix:
 *   TTY, no flags          → live ANSI dashboard (cursor-managed, loops)
 *   non-TTY, no flags      → ONE human plain-text snapshot, exit
 *   any + --json           → JSON snapshot (one-shot, or JSONL stream w/ --follow)
 *   any + --follow         → continuous (human plain per tick, or JSONL w/ --json)
 *
 * Rendering: manual ANSI cursor management (no TUI dep) for the live dashboard
 * only. Clears the screen on first render, then redraws from the top each tick
 * using cursor-home + erase-down.
 *
 * Quit: in the live dashboard, Ctrl-C (SIGINT) or 'q' restores the cursor +
 * clears its region. Non-TTY one-shots (nothing to quit); a non-TTY `--follow`
 * stream runs until the process is killed.
 *
 * No SSE consumer in v0.41 — local polling against the brain engine is
 * the foundation. SSE wiring through `serve-http.ts` is filed as a
 * v0.42 follow-up so the watch command can also stream from a remote
 * brain server (admin SPA tab in T13 does the same direct-polling fallback
 * via the engine).
 */

import type { BrainEngine } from '../core/engine.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import { clusterErrors, type ErrorCluster } from '../core/minions/error-classify.ts';
import { countRecentLeasePressure } from '../core/minions/lease-pressure-audit.ts';

const ANSI = {
  clear: '\x1b[2J',
  cursorHome: '\x1b[H',
  cursorHide: '\x1b[?25l',
  cursorShow: '\x1b[?25h',
  eraseDown: '\x1b[0J',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

export interface WatchSnapshot {
  /** Wall-clock at render time (ms since epoch). */
  ts_ms: number;
  /** Per-job-name totals over the last 24h window. */
  by_type: Array<{ name: string; total: number; completed: number; failed: number; dead: number }>;
  /** waiting / active / stalled counts (point-in-time). */
  queue_health: { waiting: number; active: number; stalled: number };
  /** Lease pressure bounces in last 1h. */
  lease_pressure_1h: number;
  /** Top-N error clusters seen in last 24h. */
  top_errors: Array<{ cluster: ErrorCluster; count: number }>;
  /** Budget owners in flight: per-owner remaining cents. */
  budget_owners: Array<{ owner_id: number; remaining_cents: number; total_spent_cents: number }>;
}

/** Pure renderer — takes a snapshot, returns the text to write. Exported for tests. */
export function renderSnapshot(s: WatchSnapshot, opts: { useAnsi?: boolean } = {}): string {
  const a = opts.useAnsi !== false;
  const c = (color: string) => (a ? color : '');
  const lines: string[] = [];
  lines.push(`${c(ANSI.bold)}gbrain jobs watch${c(ANSI.reset)}    ${c(ANSI.dim)}q to quit | ${new Date(s.ts_ms).toLocaleTimeString()}${c(ANSI.reset)}`);
  lines.push('');

  // Queue health panel.
  lines.push(`${c(ANSI.bold)}Queue${c(ANSI.reset)}    waiting=${s.queue_health.waiting}  active=${s.queue_health.active}  stalled=${s.queue_health.stalled}`);
  lines.push('');

  // Per-type breakdown.
  if (s.by_type.length > 0) {
    lines.push(`${c(ANSI.bold)}By type (24h)${c(ANSI.reset)}`);
    lines.push(`  ${'name'.padEnd(20)} ${'total'.padStart(6)} ${'done'.padStart(6)} ${'fail'.padStart(6)} ${'dead'.padStart(6)}`);
    for (const t of s.by_type.slice(0, 6)) {
      lines.push(
        `  ${t.name.padEnd(20)} ${String(t.total).padStart(6)} ${String(t.completed).padStart(6)} ${String(t.failed).padStart(6)} ${String(t.dead).padStart(6)}`,
      );
    }
    lines.push('');
  }

  // Lease pressure panel — color-coded by severity.
  const lpColor = s.lease_pressure_1h === 0
    ? c(ANSI.green)
    : s.lease_pressure_1h >= 100 ? c(ANSI.red) : c(ANSI.yellow);
  lines.push(`${c(ANSI.bold)}Lease pressure (1h)${c(ANSI.reset)}  ${lpColor}${s.lease_pressure_1h} bounce${s.lease_pressure_1h === 1 ? '' : 's'}${c(ANSI.reset)}`);
  lines.push('');

  // Top errors clustered.
  if (s.top_errors.length > 0) {
    lines.push(`${c(ANSI.bold)}Top errors (24h)${c(ANSI.reset)}`);
    for (const e of s.top_errors.slice(0, 5)) {
      lines.push(`  ${String(e.count).padStart(4)} × ${e.cluster}`);
    }
    lines.push('');
  }

  // Budget panel.
  if (s.budget_owners.length > 0) {
    lines.push(`${c(ANSI.bold)}Budget owners${c(ANSI.reset)}`);
    for (const b of s.budget_owners.slice(0, 5)) {
      const remaining = `$${(b.remaining_cents / 100).toFixed(2)}`;
      const spent = `$${(b.total_spent_cents / 100).toFixed(2)}`;
      lines.push(`  owner=${b.owner_id}  spent=${spent}  remaining=${remaining}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Read a single snapshot of dashboard state from the engine. */
export async function readSnapshot(engine: BrainEngine): Promise<WatchSnapshot> {
  const queue = new MinionQueue(engine);
  const stats = await queue.getStats();

  // Lease pressure (best-effort; pre-v93 brains return 0).
  let lease_pressure_1h = 0;
  try {
    lease_pressure_1h = await countRecentLeasePressure(engine, 3600_000);
  } catch {
    /* pre-v93 brain */
  }

  // Top errors clustered. Best-effort.
  let top_errors: Array<{ cluster: ErrorCluster; count: number }> = [];
  try {
    const errRows = await engine.executeRaw<{ id: number; last_error: string | null }>(
      `SELECT id, error_text AS last_error FROM minion_jobs
        WHERE status IN ('dead', 'failed')
          AND updated_at > now() - interval '24 hours'`,
    );
    top_errors = clusterErrors(errRows).slice(0, 5).map(c => ({ cluster: c.cluster, count: c.count }));
  } catch {
    /* DB unavailable */
  }

  // Budget owners with non-zero cents. Best-effort.
  let budget_owners: Array<{ owner_id: number; remaining_cents: number; total_spent_cents: number }> = [];
  try {
    const ownerRows = await engine.executeRaw<{
      owner_id: number;
      remaining_cents: number;
      total_spent_cents: number;
    }>(
      `SELECT
         mj.id AS owner_id,
         mj.budget_remaining_cents AS remaining_cents,
         COALESCE((SELECT SUM(ABS(cents_delta)) FROM minion_budget_log
                    WHERE owner_id = mj.id AND event_type = 'reserved'), 0) AS total_spent_cents
       FROM minion_jobs mj
       WHERE mj.budget_remaining_cents IS NOT NULL
         AND mj.budget_owner_job_id = mj.id
         AND mj.status NOT IN ('completed', 'failed', 'dead', 'cancelled')
       ORDER BY mj.id DESC
       LIMIT 5`,
    );
    budget_owners = ownerRows.map(r => ({
      owner_id: r.owner_id,
      remaining_cents: r.remaining_cents ?? 0,
      total_spent_cents: r.total_spent_cents ?? 0,
    }));
  } catch {
    /* pre-v93 brain */
  }

  return {
    ts_ms: Date.now(),
    by_type: stats.by_type.map(t => ({
      name: t.name,
      total: t.total,
      completed: t.completed,
      failed: t.failed,
      dead: t.dead,
    })),
    queue_health: stats.queue_health,
    lease_pressure_1h,
    top_errors,
    budget_owners,
  };
}

export interface WatchOptions {
  /** Refresh interval. Default 1000ms. */
  refreshMs?: number;
  /** FORMAT axis: emit JSON instead of human text. Default human. Explicit only. */
  json?: boolean;
  /**
   * LOOP axis: stream continuously. Default = `process.stdout.isTTY` — live
   * dashboard in a terminal, one snapshot then exit when non-TTY. Pass `true`
   * to force a continuous stream even off-TTY (cron tail / log pipe).
   */
  follow?: boolean;
}

export interface WatchMode {
  /** FORMAT: emit JSON instead of human text. */
  json: boolean;
  /** LOOP: continuous stream vs one-shot. */
  follow: boolean;
  /** Live cursor-managed colored dashboard (TTY + human + looping only). */
  useAnsiDashboard: boolean;
}

/**
 * Pure resolver for the format × loop matrix (extracted for unit-testing the
 * exact TTY-gating contract this command fixes, #1784). The data printed never
 * depends on isTTY; only the loop cadence + ANSI cursor management do.
 *
 * follow default = `isTTY && !json`: a terminal human view is the live
 * dashboard (loops), but `--json` (any) and non-TTY both one-shot unless the
 * caller passes `--follow` explicitly. Matches the file-header matrix.
 */
export function resolveWatchMode(opts: WatchOptions, isTTY: boolean): WatchMode {
  const json = opts.json === true;             // FORMAT: explicit only — never from isTTY.
  const follow = opts.follow ?? (isTTY && !json);
  const useAnsiDashboard = isTTY && !json && follow;
  return { json, follow, useAnsiDashboard };
}

/**
 * Main entrypoint for `gbrain jobs watch`. See the file header for the
 * format (`--json`) × loop (`--follow`) matrix. The data printed never depends
 * on isTTY; only the loop cadence and the ANSI cursor management do.
 */
export async function runWatch(engine: BrainEngine, opts: WatchOptions = {}): Promise<void> {
  const refreshMs = opts.refreshMs ?? 1000;
  const { json, follow, useAnsiDashboard } = resolveWatchMode(opts, process.stdout.isTTY === true);

  let stopped = false;
  const stop = () => {
    stopped = true;
  };

  if (useAnsiDashboard) {
    process.stdout.write(ANSI.cursorHide + ANSI.clear + ANSI.cursorHome);
    process.on('SIGINT', () => {
      process.stdout.write(ANSI.cursorShow + ANSI.clear + ANSI.cursorHome);
      stop();
      process.exit(0);
    });
    // Read stdin for 'q' keypress (terminal-only affordance).
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', (data: Buffer) => {
        if (data.toString() === 'q' || data[0] === 3) {
          process.stdout.write(ANSI.cursorShow + ANSI.clear + ANSI.cursorHome);
          stop();
          process.exit(0);
        }
      });
    }
  }

  do {
    const snap = await readSnapshot(engine);
    if (json) {
      process.stdout.write(JSON.stringify({ event: 'jobs.watch.snapshot', ...snap }) + '\n');
    } else if (useAnsiDashboard) {
      // Live dashboard: clear + cursor-home + colored render.
      process.stdout.write(ANSI.cursorHome + ANSI.eraseDown);
      process.stdout.write(renderSnapshot(snap, { useAnsi: true }));
    } else {
      // Non-TTY (or --follow without a terminal): plain human snapshot, no ANSI.
      process.stdout.write(renderSnapshot(snap, { useAnsi: false }) + '\n');
    }
    if (!follow) break;            // one-shot: render once, exit.
    await new Promise(r => setTimeout(r, refreshMs));
  } while (!stopped);
}
