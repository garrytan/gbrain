/**
 * W7 (wave 4b): the forecast horizon of a take, the last day its claim can
 * come true. Stored in `take_horizons`, one row per take, never in the takes
 * fence (a fence-format change would hold files) and never as a column on
 * `takes` (takes_list and takes_search return `t.*`, so a new column would
 * reach remote callers). The journal is private: only trusted local code
 * reads or writes it, and no MCP op exposes it.
 *
 * A row records the sha256 of the claim it was set for. When the claim is
 * edited the row stays as written but reads as not current, so a horizon
 * never silently carries over to a different proposition. Rows go with
 * their take (ON DELETE CASCADE). Nothing is written on upgrade: the stated
 * horizons come from an explicit, preview-first scan.
 *
 * Bases:
 * - `stated`: an absolute deadline in the claim's own words ("by the end of
 *   2024", "by Q3 2024", "by March 2025", "before 2025", "by 2026");
 * - `stated_relative`: "within N months|years", counted from since_date, so it
 *   is only as certain as since_date;
 * - `owner`: set by the owner (`gbrain takes horizon set`); a scan never
 *   overwrites it.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import type { HorizonBasis } from './engine-sql/takes-reads.ts';

export type { HorizonBasis };
const BASES: ReadonlySet<string> = new Set(['stated', 'stated_relative', 'owner']);

export interface StatedHorizon { date: string; basis: 'stated' | 'stated_relative'; phrase: string }
export interface TakeHorizon { take_id: number; horizon_date: string; basis: HorizonBasis; set_at: string; current: boolean }
export interface HorizonProposal { take_id: number; claim: string; horizon_date: string; basis: 'stated' | 'stated_relative'; phrase: string; replaces: string | null }
export interface HorizonScan { proposed: HorizonProposal[]; written: number; kept_owner: number; unparsed: number }

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const YEAR = '(20\\d{2})';

const claimSha = (claim: string) => createHash('sha256').update(claim).digest('hex');
const iso = (d: Date) => d.toISOString().slice(0, 10);
const endOfMonth = (year: number, monthIndex: number) => iso(new Date(Date.UTC(year, monthIndex + 1, 0)));

function validDay(s: string): boolean {
  if (!ISO_DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && iso(d) === s;
}

function addMonths(since: string, n: number): string {
  const d = new Date(`${since}T00:00:00Z`);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return iso(target);
}

const PATTERNS: Array<{ re: RegExp; date: (m: RegExpExecArray, since: string | null) => string | null; basis: 'stated' | 'stated_relative' }> = [
  { re: new RegExp(`\\bby (?:the )?end of q([1-4]) ${YEAR}\\b`, 'gi'), date: m => endOfMonth(Number(m[2]), Number(m[1]) * 3 - 1), basis: 'stated' },
  { re: new RegExp(`\\bby (?:the )?end of ${YEAR}\\b`, 'gi'), date: m => `${m[1]}-12-31`, basis: 'stated' },
  { re: new RegExp(`\\bby q([1-4]) ${YEAR}\\b`, 'gi'), date: m => endOfMonth(Number(m[2]), Number(m[1]) * 3 - 1), basis: 'stated' },
  { re: new RegExp(`\\bby (${MONTHS.join('|')}) ${YEAR}\\b`, 'gi'), date: m => endOfMonth(Number(m[2]), MONTHS.indexOf(m[1]!.toLowerCase())), basis: 'stated' },
  { re: new RegExp(`\\bbefore ${YEAR}\\b`, 'gi'), date: m => `${Number(m[1]) - 1}-12-31`, basis: 'stated' },
  { re: new RegExp(`\\bby ${YEAR}\\b(?![,.]?\\d)`, 'gi'), date: m => `${m[1]}-12-31`, basis: 'stated' },
  { re: /\bwithin (\d{1,3}) (months?|years?)\b/gi, date: (m, since) => since && validDay(since) ? addMonths(since, Number(m[1]) * (m[2]!.toLowerCase().startsWith('year') ? 12 : 1)) : null, basis: 'stated_relative' },
];

/**
 * The deadline a claim states in its own words, or null when it states none,
 * states two different ones, or states a relative one without a usable
 * since_date (YYYY-MM-DD).
 */
export function parseStatedHorizon(claim: string, sinceDate: string | null): StatedHorizon | null {
  let text = claim;
  const found: StatedHorizon[] = [];
  let unusable = false;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
      const date = p.date(m, sinceDate);
      if (date === null) unusable = true;
      else found.push({ date, basis: p.basis, phrase: m[0] });
    }
    text = text.replace(p.re, ' '.repeat(1));
  }
  if (unusable || found.length === 0) return null;
  return new Set(found.map(f => f.date)).size === 1 ? found[0]! : null;
}

/** Set (or replace) a take's horizon. Throws on an unknown take, a malformed date or an unknown basis. */
export async function setTakeHorizon(engine: BrainEngine, takeId: number, date: string, basis: HorizonBasis): Promise<void> {
  if (!validDay(date)) throw new Error(`horizon date "${date}" is not a calendar day in YYYY-MM-DD form`);
  if (!BASES.has(basis)) throw new Error(`unknown horizon basis "${basis}" (expected stated, stated_relative or owner)`);
  const claim = await engine.readTakeClaim(takeId);
  if (claim === null) throw new Error(`take ${takeId} not found`);
  await engine.upsertTakeHorizon({ takeId, claimSha256: claimSha(claim), horizonDate: date, basis });
}

/** Remove a take's horizon; true when one existed. */
export async function clearTakeHorizon(engine: BrainEngine, takeId: number): Promise<boolean> {
  return engine.deleteTakeHorizon(takeId);
}

/** Horizons by take id (all, or only the given takes); `current` is false when the claim changed since the horizon was set. */
export async function readTakeHorizons(engine: BrainEngine, takeIds?: readonly number[]): Promise<Map<number, TakeHorizon>> {
  const rows = await engine.listTakeHorizons(takeIds ? takeIds.map(Number) : null);
  return new Map(rows.map(r => [r.take_id, {
    take_id: r.take_id, horizon_date: r.horizon_date, basis: r.basis, set_at: r.set_at, current: claimSha(r.claim) === r.claim_sha256,
  }]));
}

/**
 * Propose the stated horizon of every take on a live page whose claim states
 * one and that has no current horizon with the same date; with `apply`, write
 * them. Owner-set horizons are kept as they are.
 */
export async function scanStatedHorizons(engine: BrainEngine, opts: { apply: boolean; sourceId?: string }): Promise<HorizonScan> {
  const rows = await engine.listHorizonScanRows(opts.sourceId ?? null);
  const scan: HorizonScan = { proposed: [], written: 0, kept_owner: 0, unparsed: 0 };
  for (const r of rows) {
    if (r.basis === 'owner') { scan.kept_owner++; continue; }
    const stated = parseStatedHorizon(r.claim, r.since_date);
    if (!stated) { scan.unparsed++; continue; }
    const current = r.claim_sha256 === claimSha(r.claim);
    if (current && r.horizon_date === stated.date && r.basis === stated.basis) continue;
    scan.proposed.push({ take_id: r.id, claim: r.claim, horizon_date: stated.date, basis: stated.basis, phrase: stated.phrase, replaces: r.horizon_date });
  }
  if (opts.apply) {
    for (const p of scan.proposed) {
      await setTakeHorizon(engine, p.take_id, p.horizon_date, p.basis);
      scan.written++;
    }
  }
  return scan;
}
