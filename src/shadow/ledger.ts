/**
 * The shadow ledger (plan PR S1): content-free evidence under `<shadow dir>`.
 *
 *   ledger/YYYY-MM-DD.jsonl   one row per comparison, appended by the child (UTC day)
 *   summaries/<id>.json       running counts of one child process, rewritten by that child
 *   faults.jsonl              child exits, restarts and why mirroring stopped, appended by the serving process
 *
 * A ledger row holds time, operation, outcome, reason code, both latencies and row counts: never a slug, title,
 * query, page content or source id. Every file is mode 0600. Each child owns its own summary file, so several
 * serving processes (CLI, serve, workers) never race on one file; `readShadowSummary` adds them up.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ShadowOutcome } from './classify.ts';
import { newMirrorCounters, type MirrorCounters } from './mirror.ts';

export interface ShadowLedgerRow {
  ts: string;
  op: string;
  outcome: ShadowOutcome;
  reason?: string;
  primary_ms: number;
  rust_ms: number | null;
  primary_rows: number | null;
  rust_rows: number | null;
}

export type OutcomeCounts = Partial<Record<ShadowOutcome, number>>;

export interface ShadowSummaryFile {
  version: 1;
  child_id: string;
  started_at: string;
  updated_at: string;
  first_event_at: string | null;
  last_event_at: string | null;
  by_op: Record<string, OutcomeCounts>;
  /** Comparisons the child dropped because its own queue was full. */
  child_shed: number;
  /** The latest cumulative counters the serving process sent. */
  primary: MirrorCounters;
  /** The serving process that sent them: a restarted child gets the same cumulative counters again. */
  primary_pid?: number;
}

export interface ShadowSummary {
  children: number;
  first_event_at: string | null;
  last_event_at: string | null;
  by_op: Record<string, OutcomeCounts>;
  child_shed: number;
  primary: MirrorCounters;
}

export interface ShadowFault {
  ts: string;
  kind: 'child_exit' | 'child_hung' | 'spawn_failed' | 'mirroring_disabled' | 'privacy_pause';
  detail: string;
}

/**
 * Creates a subdirectory of the shadow directory, never the shadow directory itself: `stop --delete` removes it,
 * and a late write from a still-running child must not bring the evidence back. False when the shadow directory is gone.
 */
function ensureDir(dir: string, shadowDir: string): boolean {
  if (!existsSync(shadowDir)) return false;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return true;
}

export function ledgerDir(shadowDir: string): string { return join(shadowDir, 'ledger'); }
export function summariesDir(shadowDir: string): string { return join(shadowDir, 'summaries'); }
export function faultsPath(shadowDir: string): string { return join(shadowDir, 'faults.jsonl'); }

/** Appends ledger rows for one UTC day file. */
export function appendLedgerRows(shadowDir: string, rows: readonly ShadowLedgerRow[]): void {
  if (rows.length === 0) return;
  const dir = ledgerDir(shadowDir);
  if (!ensureDir(dir, shadowDir)) return;
  const byDay = new Map<string, string[]>();
  for (const row of rows) {
    const day = row.ts.slice(0, 10);
    const lines = byDay.get(day) ?? [];
    lines.push(JSON.stringify(row));
    byDay.set(day, lines);
  }
  for (const [day, lines] of byDay) appendFileSync(join(dir, `${day}.jsonl`), lines.join('\n') + '\n', { mode: 0o600 });
}

export function writeSummaryFile(shadowDir: string, summary: ShadowSummaryFile): void {
  const dir = summariesDir(shadowDir);
  if (!ensureDir(dir, shadowDir)) return;
  const path = join(dir, `${summary.child_id}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(summary) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function appendFault(shadowDir: string, fault: ShadowFault): void {
  if (!existsSync(shadowDir)) return;
  appendFileSync(faultsPath(shadowDir), JSON.stringify(fault) + '\n', { mode: 0o600 });
}

export function readFaults(shadowDir: string, limit = 20): ShadowFault[] {
  const path = faultsPath(shadowDir);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const out: ShadowFault[] = [];
  for (const line of lines.slice(-limit)) {
    try { out.push(JSON.parse(line) as ShadowFault); } catch { /* skip a torn line */ }
  }
  return out;
}

function minIso(a: string | null, b: string | null): string | null { return !a ? b : !b ? a : a < b ? a : b; }
function maxIso(a: string | null, b: string | null): string | null { return !a ? b : !b ? a : a > b ? a : b; }

/** Adds up every child's summary file. */
export function readShadowSummary(shadowDir: string): ShadowSummary {
  const total: ShadowSummary = { children: 0, first_event_at: null, last_event_at: null, by_op: {}, child_shed: 0, primary: newMirrorCounters() };
  const dir = summariesDir(shadowDir);
  const byPid = new Map<number | string, MirrorCounters>();
  if (!existsSync(dir)) return total;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    let file: ShadowSummaryFile;
    try { file = JSON.parse(readFileSync(join(dir, name), 'utf8')) as ShadowSummaryFile; } catch { continue; }
    if (file?.version !== 1) continue;
    total.children++;
    total.first_event_at = minIso(total.first_event_at, file.first_event_at);
    total.last_event_at = maxIso(total.last_event_at, file.last_event_at);
    total.child_shed += file.child_shed ?? 0;
    for (const [op, counts] of Object.entries(file.by_op ?? {})) {
      const into = total.by_op[op] ?? (total.by_op[op] = {});
      for (const [outcome, n] of Object.entries(counts) as Array<[ShadowOutcome, number]>) into[outcome] = (into[outcome] ?? 0) + n;
    }
    // Cumulative per serving process: the latest file of one process wins, files of different processes add.
    const mine = byPid.get(file.primary_pid ?? name) ?? newMirrorCounters();
    for (const key of Object.keys(mine) as Array<keyof MirrorCounters>) mine[key] = Math.max(mine[key], file.primary?.[key] ?? 0);
    byPid.set(file.primary_pid ?? name, mine);
  }
  for (const counters of byPid.values()) {
    for (const key of Object.keys(total.primary) as Array<keyof MirrorCounters>) total.primary[key] += counters[key];
  }
  return total;
}
