/**
 * Nightly learning PR 1: per-night stats over the learning ledger, the scoreboard behind "learns every night".
 *
 * A night is the owner's local day ending 06:00 in brain.timezone (UTC when unset or invalid), so a 03:00 cycle counts
 * toward the night before. The bar's numerator for a night is its change items (fact_added, promise_found,
 * page_filled) that were kept, or shown and not undone within 7 days of being shown. Expired and never-shown items
 * never count; you_wrote items never count; questions are reported apart. The scoreboard is the share of nights with
 * at least 5 counted items. A caller that does not read the whole ledger (a remote caller other than the owner) gets
 * stats over the items it can read now, so its counts never reveal what it cannot read.
 */

import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { isValidTimeZone } from '../cycle/cycle-date.ts';
import { CHANGE_KINDS, QUESTION_KINDS, type LearningKind } from './kinds.ts';
import { callerFilters, liveItems } from './read.ts';

export const STATS_DEFAULT_DAYS = 30;
export const NIGHT_ENDS_HOUR = 6;
export const BAR_ITEMS_PER_NIGHT = 5;
const UNDO_GRACE_MS = 7 * 86_400_000;
/** The most ledger rows one stats read considers. */
const STATS_ROW_CAP = 20_000;

export interface NightStats {
  night: string; change_items: number; shown: number; kept: number; undone: number; expired: number; counted: number;
  questions: number; answered: number; you_wrote: number;
}
export interface LearnedStats {
  timezone: string; night_ends: string; since: string; scope: 'ledger' | 'readable';
  nights: NightStats[]; nights_total: number; nights_with_bar: number; bar: number; share_with_bar: number | null;
  /** True when more ledger rows than the read cap fell in the range: the newest rows were read, so the oldest night may be partial. */
  truncated: boolean;
}

/** The night an instant belongs to: its local calendar date in `timeZone`, or the day before when local time is before 06:00. */
export function nightOf(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)?.value);
  const day = new Date(Date.UTC(part('year'), part('month') - 1, part('day') - (part('hour') < NIGHT_ENDS_HOUR ? 1 : 0)));
  return day.toISOString().slice(0, 10);
}

export async function brainTimeZone(engine: Pick<BrainEngine, 'getConfig'>): Promise<string> {
  const configured = (await engine.getConfig('brain.timezone'))?.trim();
  return configured && isValidTimeZone(configured) ? configured : 'UTC';
}

interface LedgerRow { id: number | string; kind: LearningKind; state: string; created_at: string; shown_at: string | null; decided_at: string | null }

/** Whether a change item counts toward the bar (see the module comment). */
export function countsTowardBar(row: Pick<LedgerRow, 'kind' | 'state' | 'shown_at' | 'decided_at'>): boolean {
  if (!CHANGE_KINDS.includes(row.kind) || row.state === 'expired') return false;
  if (row.state === 'kept') return true;
  if (!row.shown_at) return false;
  if (row.state !== 'undone') return true;
  return !row.decided_at || Date.parse(row.decided_at) - Date.parse(row.shown_at) > UNDO_GRACE_MS;
}

export async function learnedStats(engine: BrainEngine, ctx: OperationContext, opts: { sourceIds: string[] | null; since?: Date; now?: Date; rowCap?: number }): Promise<LearnedStats> {
  const rowCap = opts.rowCap ?? STATS_ROW_CAP;
  const now = opts.now ?? new Date();
  const since = opts.since ?? new Date(now.getTime() - STATS_DEFAULT_DAYS * 86_400_000);
  const timeZone = await brainTimeZone(engine);
  const iso = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  let rows = await engine.executeRaw<LedgerRow>(`SELECT id, kind, state, ${iso('created_at')} AS created_at, ${iso('shown_at')} AS shown_at, ${iso('decided_at')} AS decided_at
      FROM learning_items WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[])) AND created_at >= $2::timestamptz
     ORDER BY created_at DESC, id DESC LIMIT $3`, [opts.sourceIds, since.toISOString(), rowCap + 1]);
  const truncated = rows.length > rowCap;
  if (truncated) rows = rows.slice(0, rowCap);
  const filters = await callerFilters(engine, ctx);
  if (!filters.full) {
    const readable = new Set((await liveItems(engine, ctx, filters, { sourceIds: opts.sourceIds, since, unseenOnly: false, limit: rowCap })).map(i => i.id));
    rows = rows.filter(r => readable.has(String(r.id)));
  }
  const nights = new Map<string, NightStats>();
  for (const row of rows) {
    const night = nightOf(new Date(row.created_at), timeZone);
    const n = nights.get(night) ?? { night, change_items: 0, shown: 0, kept: 0, undone: 0, expired: 0, counted: 0, questions: 0, answered: 0, you_wrote: 0 };
    nights.set(night, n);
    if (row.kind === 'you_wrote') { n.you_wrote++; continue; }
    if (QUESTION_KINDS.includes(row.kind)) { n.questions++; if (row.state === 'answered') n.answered++; continue; }
    n.change_items++;
    if (row.shown_at) n.shown++;
    if (row.state === 'kept') n.kept++;
    if (row.state === 'undone') n.undone++;
    if (row.state === 'expired') n.expired++;
    if (countsTowardBar(row)) n.counted++;
  }
  const list = [...nights.values()].sort((a, b) => a.night.localeCompare(b.night));
  const withBar = list.filter(n => n.counted >= BAR_ITEMS_PER_NIGHT).length;
  return {
    timezone: timeZone, night_ends: `0${NIGHT_ENDS_HOUR}:00`, since: since.toISOString(), scope: filters.full ? 'ledger' : 'readable',
    nights: list, nights_total: list.length, nights_with_bar: withBar, bar: BAR_ITEMS_PER_NIGHT,
    share_with_bar: list.length ? Math.round((withBar / list.length) * 1000) / 1000 : null, truncated,
  };
}

export function formatLearnedStats(stats: LearnedStats): string {
  if (!stats.nights.length) return `No learning recorded since ${stats.since.slice(0, 10)}.\n`;
  const lines = [`Nights since ${stats.since.slice(0, 10)} (a night ends at ${stats.night_ends} ${stats.timezone}):`];
  for (const n of stats.nights) {
    lines.push(`  ${n.night}: ${n.counted} counted of ${n.change_items} changes (shown ${n.shown}, kept ${n.kept}, undone ${n.undone}, expired ${n.expired}); ${n.questions} questions (${n.answered} answered); ${n.you_wrote} you wrote`);
  }
  lines.push(`${stats.nights_with_bar} of ${stats.nights_total} nights reached ${stats.bar} counted items.`);
  if (stats.truncated) lines.push('Truncated: too many items to read at once, so only the newest were counted; the oldest night shown may be incomplete. Pass a later --since.');
  return lines.join('\n') + '\n';
}
