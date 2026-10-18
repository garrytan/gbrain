/**
 * The daily spend cap on open-loop extraction (#5445 follow-up, wave 14 P4.6b).
 *
 * `loops.extraction_max_usd_per_day` (default $2.00; 0 means no paid loop
 * extraction) bounds what `loops_extract` jobs may spend per UTC day, brain
 * wide. Both enqueue sites (the sweep's `enqueueLoopsExtraction` and the
 * managed catch-up) stamp every job with the day's spend authorization, a
 * group record keyed on the day (`loops_extract:<YYYY-MM-DD>`), so the worker
 * runs each job under `runWithJobSpend`: every provider attempt reserves its
 * maximum against `group:<day group>` in the durable meter and settles its
 * measured usage; an attempt the cap cannot admit is refused BEFORE the
 * provider call (`cost_cap_exceeded`), the job dies without spending, and the
 * next sweep that touches the thread queues it under a later day. A sweep
 * that finds the day's group already at its cap queues nothing and reports
 * `daily_spend_cap` as its skip reason.
 *
 * A stored value makes the cap `user`-sourced: a model with no known price is
 * then refused rather than run unmetered (the same rule every user cap has).
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { readGroupSpend } from '../minions/budget-meter.ts';
import type { SpendAuthorization } from '../minions/spend-record.ts';

export const LOOPS_EXTRACT_MAX_USD_PER_DAY_KEY = 'loops.extraction_max_usd_per_day';
export const LOOPS_EXTRACT_DEFAULT_MAX_USD_PER_DAY = 2;
/** The `command` every day group records; the resume guidance names it. */
export const LOOPS_EXTRACT_SPEND_COMMAND = 'loops_extract';

/** Null when the value is valid for `loops.extraction_max_usd_per_day`; otherwise the refusal text (nothing is written). */
export function validateLoopsSpendConfigValue(key: string, value: string): string | null {
  if (key !== LOOPS_EXTRACT_MAX_USD_PER_DAY_KEY) return null;
  return parseUsd(value) === null
    ? `${key} must be a non-negative USD amount such as 2.00 (0 means no paid loop extraction; got "${value}"). Nothing was written.`
    : null;
}

function parseUsd(value: string): number | null {
  const text = value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const usd = Number(text);
  return Number.isFinite(usd) ? usd : null;
}

export interface LoopsExtractDailyCap {
  capUsd: number;
  /** `user` when the key is stored, `default` otherwise. */
  source: 'user' | 'default';
}

/** The cap in force; an unset or unreadable value keeps the default. */
export async function readLoopsExtractDailyCap(engine: Pick<BrainEngine, 'getConfig'>): Promise<LoopsExtractDailyCap> {
  try {
    const value = await engine.getConfig(LOOPS_EXTRACT_MAX_USD_PER_DAY_KEY);
    const usd = typeof value === 'string' ? parseUsd(value) : null;
    if (usd !== null) return { capUsd: usd, source: 'user' };
  } catch {
    // unreadable config keeps the default
  }
  return { capUsd: LOOPS_EXTRACT_DEFAULT_MAX_USD_PER_DAY, source: 'default' };
}

/** The UTC day a job is charged to, `YYYY-MM-DD`. */
export const loopsSpendDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

/**
 * The day's group id: a UUID derived from the day, so every enqueue site of
 * every process lands the day's jobs in one group without coordination.
 */
export function loopsSpendGroupId(day: string): string {
  const h = createHash('sha256').update(`${LOOPS_EXTRACT_SPEND_COMMAND}:${day}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const loopsSpendBudgetKey = (day: string): string => `group:${loopsSpendGroupId(day)}`;

/** The record both enqueue sites stamp on the day's jobs; null when the cap is 0 (nothing may be queued). */
export function loopsExtractSpendAuthorization(cap: LoopsExtractDailyCap, nowMs: number): SpendAuthorization | null {
  if (cap.capUsd <= 0) return null;
  const day = loopsSpendDay(nowMs);
  return {
    version: 1, kind: 'authorized', group_id: loopsSpendGroupId(day),
    consented_effects: ['paid'], cap_usd: cap.capUsd, cap_source: cap.source, via: 'preapproval',
    command: LOOPS_EXTRACT_SPEND_COMMAND, authorized_at: new Date(nowMs).toISOString(),
  };
}

export type LoopsSpendGate =
  | { ok: true; record: SpendAuthorization; day: string; spentUsd: number; capUsd: number }
  | { ok: false; reason: 'spend_cap_zero' | 'daily_spend_cap'; day: string; spentUsd: number; capUsd: number; message: string };

/**
 * What an enqueue site may do today: the record to stamp, or the reason to
 * queue nothing. Settled spend plus overdue holds at or over the cap closes
 * the day; live holds of jobs still running do not (the worker's own
 * reservation refuses them if they would overrun).
 */
export async function loopsSpendGate(engine: BrainEngine, nowMs = Date.now()): Promise<LoopsSpendGate> {
  const cap = await readLoopsExtractDailyCap(engine);
  const day = loopsSpendDay(nowMs);
  const raise = `raise it with \`gbrain config set ${LOOPS_EXTRACT_MAX_USD_PER_DAY_KEY} <usd>\``;
  if (cap.capUsd <= 0) {
    return { ok: false, reason: 'spend_cap_zero', day, spentUsd: 0, capUsd: 0,
      message: `${LOOPS_EXTRACT_MAX_USD_PER_DAY_KEY} is 0, so no paid loop extraction is queued; ${raise}` };
  }
  let spentUsd = 0;
  try {
    const spend = await readGroupSpend(engine, loopsSpendBudgetKey(day));
    spentUsd = (spend.committedCents + spend.overdueCents) / 100;
  } catch {
    // an unreadable meter admits the enqueue; the worker's reservation still enforces the cap
  }
  if (spentUsd >= cap.capUsd) {
    return { ok: false, reason: 'daily_spend_cap', day, spentUsd, capUsd: cap.capUsd,
      message: `loop extraction spent $${spentUsd.toFixed(2)} of its $${cap.capUsd.toFixed(2)} ${cap.source} cap for ${day} (UTC); nothing more is queued today, the threads are queued on their next touch tomorrow; ${raise}` };
  }
  return { ok: true, record: loopsExtractSpendAuthorization(cap, nowMs)!, day, spentUsd, capUsd: cap.capUsd };
}
