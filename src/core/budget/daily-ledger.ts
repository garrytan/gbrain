/**
 * Durable per-UTC-day USD ledger over `budget_ledger` and
 * `budget_reservations` (migration v012). One ledger is a (scope, resolver)
 * pair; its rows are keyed by UTC date, so every process on the brain (the
 * maintenance cycle, the CLI) shares one daily ceiling.
 *
 * Protocol for one paid call: `reserve(estimate)` → `dispatch(id)` → call →
 * `settle(id, actual)`; `release(id)` when the call is abandoned before
 * dispatch. A refused reserve, a failed dispatch or any ledger error means
 * the caller makes no call (`ledger_unavailable`); `meteredCall` runs the
 * whole protocol so a caller cannot get the order wrong.
 *
 * Reservation states: `held` → `dispatched` → `settled` | `overrun`, or
 * `held` → `released`. Expired reservations are reclaimed before each
 * reserve: an undispatched one is released, a dispatched one settles at its
 * estimate (`settled_uncertain`: usage unknown, so charge the reserved
 * maximum). A late settle still records the real cost against the
 * reservation's own UTC day. Amounts are NUMERIC(12,4), rounded up.
 *
 * The ledger never opens a BudgetTracker scope: a caller's ambient tracker
 * (doctor --remediate) keeps metering the gateway call it wraps.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { CANONICAL_PRICING, type ModelPricing } from '../model-pricing.ts';
import type { CapSource } from '../consent.ts';
import { priceFor, type PricingOverrides, type PricingSource } from './reservation-cost.ts';
import { noPricingGuidance, type NoPricingGuidance } from './no-pricing.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';

/** The day read is readBudgetLedgerDay (the fence census members); the writes are typed members (engine-sql/budget-ledger-writes.ts). */
type Exec = Pick<BrainEngine, 'executeRaw' | 'readBudgetLedgerDay' | 'reclaimBudgetReservations' | 'reserveBudgetReservation' | 'dispatchBudgetReservation'
  | 'settleBudgetReservation' | 'releaseBudgetReservation'>;

export interface LedgerKey { scope: string; resolver: string }
export const FENCE_REPAIR_LEDGER: LedgerKey = Object.freeze({ scope: 'llm_repair', resolver: 'fences' });

export type ReservationStatus = 'held' | 'dispatched' | 'settled' | 'overrun' | 'released' | 'settled_uncertain';
export interface Reservation { id: string; day: string; estimateUsd: number; expiresAt: string }
export interface LedgerDay { day: string; reservedUsd: number; committedUsd: number; capUsd: number | null }

export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: 'budget_exhausted'; day: string; estimateUsd: number; capUsd: number; committedUsd: number; reservedUsd: number; resetsAt: string }
  | { ok: false; reason: 'ledger_unavailable'; day: string };

export type SettleResult =
  | { settled: true; day: string; actualUsd: number; overrunUsd: number; prior: ReservationStatus }
  | { settled: false; reason: 'already_settled' | 'unknown_reservation' | 'ledger_unavailable'; prior?: ReservationStatus };

export interface DailyLedger {
  reserve(estimateUsd: number, opts: { capUsd: number; ttlMs?: number }): Promise<ReserveResult>;
  dispatch(id: string): Promise<boolean>;
  settle(id: string, actualUsd: number): Promise<SettleResult>;
  release(id: string): Promise<boolean>;
  reclaimExpired(): Promise<{ released: number; settledUncertain: number }>;
  readDay(day?: string): Promise<LedgerDay>;
}

/** Default reservation lifetime; it must outlive the provider call's timeout. */
export const DEFAULT_RESERVATION_TTL_MS = 10 * 60_000;

/** USD at the ledger's 4 decimal places: spend rounds up (never under-counts), a cap rounds down (never loosens). */
export function ledgerUsd(usd: number, round: 'up' | 'down' = 'up'): string {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError('A ledger amount must be a finite, non-negative USD value.');
  const units = round === 'up' ? Math.ceil(usd * 10_000 - 1e-6) : Math.floor(usd * 10_000 + 1e-6);
  return (units / 10_000).toFixed(4);
}

export function utcDay(at: Date): string { return at.toISOString().slice(0, 10); }

/** The next 00:00 UTC after `at`, when a new ledger day starts. */
export function nextUtcMidnight(at: Date): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1)).toISOString();
}

/** The ledger for one (scope, resolver); `now` is injectable so tests control the UTC day and expiry. */
export function dailyLedger(engine: Exec, key: LedgerKey, opts: { now?: () => Date } = {}): DailyLedger {
  const now = opts.now ?? (() => new Date());
  const params = (...rest: unknown[]) => [key.scope, key.resolver, ...rest];

  const readDay = async (day = utcDay(now())): Promise<LedgerDay> => {
    // engine-sql/fence-census.ts: the same SELECT, served by the Rust store as no row.
    const row = await engine.readBudgetLedgerDay(key.scope, key.resolver, day);
    return { day, reservedUsd: Number(row?.reserved ?? 0), committedUsd: Number(row?.committed ?? 0), capUsd: row?.cap == null ? null : Number(row.cap) };
  };

  const reclaimExpired = async () => {
    const row = await engine.reclaimBudgetReservations(key, now().toISOString());
    return { released: row.released, settledUncertain: row.uncertain };
  };

  const reserve = async (estimateUsd: number, o: { capUsd: number; ttlMs?: number }): Promise<ReserveResult> => {
    const at = now();
    const day = utcDay(at);
    const estimate = ledgerUsd(estimateUsd);
    const cap = ledgerUsd(o.capUsd, 'down');
    const id = randomUUID();
    try {
      await reclaimExpired();
      const expiresAt = new Date(at.getTime() + (o.ttlMs ?? DEFAULT_RESERVATION_TTL_MS)).toISOString();
      if (await engine.reserveBudgetReservation(key, { day, estimate, cap, id, at: at.toISOString(), expiresAt })) return { ok: true, reservation: { id, day, estimateUsd: Number(estimate), expiresAt } };
      const totals = await readDay(day);
      return { ok: false, reason: 'budget_exhausted', day, estimateUsd: Number(estimate), capUsd: Number(cap),
        committedUsd: totals.committedUsd, reservedUsd: totals.reservedUsd, resetsAt: nextUtcMidnight(at) };
    } catch {
      return { ok: false, reason: 'ledger_unavailable', day };
    }
  };

  const dispatch = async (id: string): Promise<boolean> => {
    try {
      return await engine.dispatchBudgetReservation(key, id, now().toISOString());
    } catch { return false; }
  };

  const settle = async (id: string, actualUsd: number): Promise<SettleResult> => {
    const actual = ledgerUsd(actualUsd);
    let row: { prior: ReservationStatus | null; estimate: string | null; day: string | null; current: ReservationStatus | null } | null;
    try { row = await engine.settleBudgetReservation(key, id, actual) as typeof row; } catch { return { settled: false, reason: 'ledger_unavailable' }; }
    if (!row?.prior) return row?.current ? { settled: false, reason: 'already_settled', prior: row.current } : { settled: false, reason: 'unknown_reservation' };
    const overrun = Math.max(0, Number(actual) - Number(row.estimate));
    return { settled: true, day: row.day!, actualUsd: Number(actual), overrunUsd: Number(overrun.toFixed(4)), prior: row.prior };
  };

  const release = async (id: string): Promise<boolean> => {
    // An engine that cannot run the ledger refuses; false would leave the hold in place with no reason.
    try { return await engine.releaseBudgetReservation(key, id); } catch (e) { rethrowCapabilityRefusal(e); return false; }
  };

  return { reserve, dispatch, settle, release, reclaimExpired, readDay };
}

export type MeteredCallResult<T> =
  | { ok: true; value: T; reservation: Reservation; settle: SettleResult }
  | Exclude<ReserveResult, { ok: true }>
  | { ok: false; reason: 'ledger_unavailable'; day: string; stage: 'dispatch' };

/**
 * One paid call under the ledger. `call` runs only after the reservation is
 * held and marked dispatched, and returns its actual cost; a throwing call
 * settles at the reserved estimate (usage unknown) and rethrows.
 */
export async function meteredCall<T>(ledger: DailyLedger, budget: { estimateUsd: number; capUsd: number; ttlMs?: number },
  call: (reservation: Reservation) => Promise<{ value: T; actualUsd: number }>): Promise<MeteredCallResult<T>> {
  const reserved = await ledger.reserve(budget.estimateUsd, budget);
  if (!reserved.ok) return reserved;
  const { reservation } = reserved;
  if (!await ledger.dispatch(reservation.id)) {
    await ledger.release(reservation.id);
    return { ok: false, reason: 'ledger_unavailable', day: reservation.day, stage: 'dispatch' };
  }
  let outcome: { value: T; actualUsd: number };
  try { outcome = await call(reservation); } catch (error) {
    await ledger.settle(reservation.id, reservation.estimateUsd);
    throw error;
  }
  return { ok: true, value: outcome.value, reservation, settle: await ledger.settle(reservation.id, outcome.actualUsd) };
}

/** Rate for a chat model the price tables do not know: the highest input and output rates in the canonical table. */
export function unpricedChatCeiling(): ModelPricing {
  const rows = Object.values(CANONICAL_PRICING);
  return { input: Math.max(...rows.map(r => r.input)), output: Math.max(...rows.map(r => r.output)) };
}

export interface ChatCostQuote {
  usd: number;
  /** True when the model is unpriced and the quote is the canonical-table ceiling, not its real rate. */
  estimated: boolean;
  source: PricingSource | 'ceiling';
}

/** USD for a chat call's token counts: operator overrides, then the shipped tables, else the ceiling rate. */
export function chatCallUsd(model: string, tokens: { inputTokens: number; outputTokens: number }, overrides?: PricingOverrides): ChatCostQuote {
  const priced = priceFor(model, 'chat', overrides);
  const rate = priced?.pricing ?? unpricedChatCeiling();
  const usd = (tokens.inputTokens / 1_000_000) * rate.input + (tokens.outputTokens / 1_000_000) * rate.output;
  return { usd, estimated: !priced, source: priced?.source ?? 'ceiling' };
}

/**
 * The most one chat call can cost: input estimate plus the full output
 * ceiling. An unpriced model runs under a default cap at the ceiling rate
 * (`estimated: true`); under a cap the user set it refuses with the
 * `gbrain pricing set` guidance, because that cap cannot be enforced.
 */
export function estimateChatCallUsd(input: { model: string; inputTokens: number; maxOutputTokens: number; overrides?: PricingOverrides; capSource: CapSource }):
  { ok: true; quote: ChatCostQuote } | { ok: false; reason: 'no_pricing'; guidance: NoPricingGuidance } {
  const quote = chatCallUsd(input.model, { inputTokens: input.inputTokens, outputTokens: input.maxOutputTokens }, input.overrides);
  if (quote.estimated && input.capSource === 'user') return { ok: false, reason: 'no_pricing', guidance: noPricingGuidance(input.model, 'chat') };
  return { ok: true, quote };
}
