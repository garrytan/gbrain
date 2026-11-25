/**
 * Criterion 5's per-brain write bar (docs/designs/RUST_ENGINE.md D26 and "Swap readiness"): how many compared writes a
 * brain needs before the swap, scaled to how much that brain writes.
 *
 *   bar = min(WRITE_BAR_CAP, max(WRITE_BAR_FLOOR, window_days x W))
 *
 * `window_days` is criterion 1's shadow minimum in force (5 days while the opt-in override applies, 14 after), and W is
 * the brain's qualifying writes a day: every call of a qualifying write member the shadow wrapper saw, sampled out or
 * compared, over the last `window_days` UTC days, divided by the days the call history covers (a history shorter than
 * the window is scaled up, never padded with zeros). Zero unexplained differences stay required; below the floor the
 * check stays closed.
 *
 * The counts come from `<shadow dir>/write-usage/YYYY-MM-DD.jsonl`, written by each serving process (attach.ts) the way
 * read usage is (usage.ts), but in a directory of its own so read coverage (criterion 2) never sees a write operation.
 * Content-free: operation names and counts only.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonlStrict } from './ledger.ts';
import type { UsageLine } from './usage.ts';

/** The gbrain-path writes the bar counts. The sync-import members join this list when their comparison lands. */
export const QUALIFYING_WRITE_OPS: ReadonlySet<string> = new Set(['putPage', 'deletePage', 'addLink', 'addLinksBatch', 'removeLink']);

export const WRITE_BAR_CAP = 1_000;
export const WRITE_BAR_FLOOR = 100;
/** The longest window the bar reads: the default shadow minimum. */
export const WRITE_HISTORY_DAYS = 14;

const DAY_MS = 86_400_000;

export const writeUsageDir = (shadowDir: string): string => join(shadowDir, 'write-usage');

/** Appends one write-usage line. Never creates the shadow directory itself (a late flush after `stop --delete`). */
export function appendWriteUsage(shadowDir: string, line: UsageLine): void {
  if (!existsSync(shadowDir)) return;
  mkdirSync(writeUsageDir(shadowDir), { recursive: true, mode: 0o700 });
  appendFileSync(join(writeUsageDir(shadowDir), `${line.ts.slice(0, 10)}.jsonl`), JSON.stringify(line) + '\n', { mode: 0o600 });
}

/** The brain's qualifying write calls by UTC day, over every epoch. */
export interface QualifyingWrites {
  /** `YYYY-MM-DD` -> calls of a qualifying write member that day (offered: sampled-out calls included). */
  by_day: Record<string, number>;
  /** The first line of the call history, or null when no process has noted a write yet. */
  first_seen: string | null;
}

/**
 * The last WRITE_HISTORY_DAYS days of qualifying write calls; null when a write-usage file cannot be read whole (the
 * bar is then missing evidence, never zero).
 */
export function readQualifyingWrites(shadowDir: string, now: Date = new Date()): QualifyingWrites | null {
  const dir = writeUsageDir(shadowDir);
  const out: QualifyingWrites = { by_day: {}, first_seen: null };
  if (!existsSync(dir)) return out;
  const oldest = new Date(now.getTime() - (WRITE_HISTORY_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const lines = readJsonlStrict<UsageLine>(join(dir, name));
    if (lines === null) return null;
    for (const l of lines) {
      if (!l || typeof l.ts !== 'string' || !l.ops || typeof l.ops !== 'object') continue;
      if (out.first_seen === null || l.ts < out.first_seen) out.first_seen = l.ts;
      const day = l.ts.slice(0, 10);
      if (day < oldest) continue;
      for (const [op, u] of Object.entries(l.ops)) {
        if (!QUALIFYING_WRITE_OPS.has(op)) continue;
        out.by_day[day] = (out.by_day[day] ?? 0) + (Number(u?.offered) || 0);
      }
    }
  }
  return out;
}

export interface WriteBar {
  window_days: number;
  /** Qualifying write calls in the window. */
  writes_in_window: number;
  /** Days of call history the window holds: the window, or fewer when the history began inside it (at least 1). */
  covered_days: number;
  /** W: writes a day, `writes_in_window / covered_days`. */
  per_day: number;
  bar: number;
}

/** The bar for a `windowDays` window ending at `now` (inclusive UTC days). */
export function writeBar(history: QualifyingWrites, windowDays: number, now: Date): WriteBar {
  const window = Math.max(1, Math.round(windowDays));
  let writes = 0;
  for (let i = 0; i < window; i++) writes += history.by_day[new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10)] ?? 0;
  const first = history.first_seen ? Date.parse(history.first_seen) : NaN;
  const span = Number.isFinite(first) ? Math.ceil((now.getTime() - first) / DAY_MS) : window;
  const covered = Math.min(window, Math.max(1, span));
  const perDay = writes / covered;
  return { window_days: window, writes_in_window: writes, covered_days: covered, per_day: perDay,
    bar: Math.min(WRITE_BAR_CAP, Math.max(WRITE_BAR_FLOOR, Math.round(window * perDay))) };
}

/** How the report states the bar: the bar, the window and how W was computed. */
export function describeWriteBar(b: WriteBar): string {
  return `bar ${b.bar} = min(${WRITE_BAR_CAP}, max(${WRITE_BAR_FLOOR}, ${b.window_days}-day window x ${b.per_day.toFixed(1)} qualifying writes a day))`
    + `; W = ${b.writes_in_window} calls of ${[...QUALIFYING_WRITE_OPS].join(', ')} over ${b.covered_days} day(s) of the brain's own call counts, sampled-out calls included`;
}
