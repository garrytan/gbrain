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

type Exec = Pick<BrainEngine, 'executeRaw'>;

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

const RESERVE_SQL = `WITH up AS (
  INSERT INTO budget_ledger AS l (scope, resolver_id, local_date, reserved_usd, committed_usd, cap_usd)
  SELECT $1, $2, $3::date, $4::numeric, 0, $5::numeric WHERE $4::numeric <= $5::numeric
  ON CONFLICT (scope, resolver_id, local_date) DO UPDATE
    SET reserved_usd = l.reserved_usd + EXCLUDED.reserved_usd, cap_usd = EXCLUDED.cap_usd, updated_at = now()
    WHERE l.reserved_usd + l.committed_usd + EXCLUDED.reserved_usd <= EXCLUDED.cap_usd
  RETURNING l.local_date
), ins AS (
  INSERT INTO budget_reservations (reservation_id, scope, resolver_id, local_date, estimate_usd, reserved_at, expires_at, status)
  SELECT $6, $1, $2, up.local_date, $4::numeric, $7::timestamptz, $8::timestamptz, 'held' FROM up
  RETURNING reservation_id
)
SELECT reservation_id FROM ins`;

const RECLAIM_SQL = `WITH expired AS (
  UPDATE budget_reservations SET status = CASE status WHEN 'held' THEN 'released' ELSE 'settled_uncertain' END
  WHERE scope = $1 AND resolver_id = $2 AND status IN ('held', 'dispatched') AND expires_at <= $3::timestamptz
  RETURNING local_date, estimate_usd, status
), per_day AS (
  SELECT local_date, sum(estimate_usd) AS freed,
    sum(CASE WHEN status = 'settled_uncertain' THEN estimate_usd ELSE 0 END) AS charged,
    count(*) FILTER (WHERE status = 'released') AS released, count(*) FILTER (WHERE status = 'settled_uncertain') AS uncertain
  FROM expired GROUP BY local_date
), applied AS (
  UPDATE budget_ledger l SET reserved_usd = l.reserved_usd - d.freed, committed_usd = l.committed_usd + d.charged, updated_at = now()
  FROM per_day d WHERE l.scope = $1 AND l.resolver_id = $2 AND l.local_date = d.local_date
  RETURNING 1
)
SELECT COALESCE(sum(released), 0)::int AS released, COALESCE(sum(uncertain), 0)::int AS uncertain FROM per_day`;

const SETTLE_SQL = `WITH prior AS (
  SELECT reservation_id, status, estimate_usd, local_date FROM budget_reservations
  WHERE reservation_id = $3 AND scope = $1 AND resolver_id = $2 FOR UPDATE
), r AS (
  UPDATE budget_reservations b SET status = CASE WHEN $4::numeric > p.estimate_usd THEN 'overrun' ELSE 'settled' END
  FROM prior p WHERE b.reservation_id = p.reservation_id AND p.status IN ('held', 'dispatched', 'released', 'settled_uncertain')
  RETURNING p.status AS prior, p.estimate_usd, p.local_date
), applied AS (
  UPDATE budget_ledger l SET
    reserved_usd = l.reserved_usd - CASE WHEN r.prior IN ('held', 'dispatched') THEN r.estimate_usd ELSE 0 END,
    committed_usd = l.committed_usd + $4::numeric - CASE WHEN r.prior = 'settled_uncertain' THEN r.estimate_usd ELSE 0 END,
    updated_at = now()
  FROM r WHERE l.scope = $1 AND l.resolver_id = $2 AND l.local_date = r.local_date
  RETURNING 1
)
SELECT r.prior, r.estimate_usd::text AS estimate, r.local_date::text AS day, (SELECT status FROM prior) AS current FROM r
UNION ALL SELECT NULL, NULL, NULL, (SELECT status FROM prior) WHERE NOT EXISTS (SELECT 1 FROM r)`;

const RELEASE_SQL = `WITH r AS (
  UPDATE budget_reservations SET status = 'released'
  WHERE reservation_id = $3 AND scope = $1 AND resolver_id = $2 AND status = 'held'
  RETURNING local_date, estimate_usd
)
UPDATE budget_ledger l SET reserved_usd = l.reserved_usd - r.estimate_usd, updated_at = now()
FROM r WHERE l.scope = $1 AND l.resolver_id = $2 AND l.local_date = r.local_date
RETURNING 1`;

/** The ledger for one (scope, resolver); `now` is injectable so tests control the UTC day and expiry. */
export function dailyLedger(engine: Exec, key: LedgerKey, opts: { now?: () => Date } = {}): DailyLedger {
  const now = opts.now ?? (() => new Date());
  const params = (...rest: unknown[]) => [key.scope, key.resolver, ...rest];

  const readDay = async (day = utcDay(now())): Promise<LedgerDay> => {
    const [row] = await engine.executeRaw<{ reserved: string; committed: string; cap: string | null }>(
      'SELECT reserved_usd::text AS reserved, committed_usd::text AS committed, cap_usd::text AS cap FROM budget_ledger WHERE scope = $1 AND resolver_id = $2 AND local_date = $3::date',
      params(day));
    return { day, reservedUsd: Number(row?.reserved ?? 0), committedUsd: Number(row?.committed ?? 0), capUsd: row?.cap == null ? null : Number(row.cap) };
  };

  const reclaimExpired = async () => {
    const [row] = await engine.executeRaw<{ released: number; uncertain: number }>(RECLAIM_SQL, params(now().toISOString()));
    return { released: Number(row?.released ?? 0), settledUncertain: Number(row?.uncertain ?? 0) };
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
      const rows = await engine.executeRaw<{ reservation_id: string }>(RESERVE_SQL, params(day, estimate, cap, id, at.toISOString(), expiresAt));
      if (rows.length === 1) return { ok: true, reservation: { id, day, estimateUsd: Number(estimate), expiresAt } };
      const totals = await readDay(day);
      return { ok: false, reason: 'budget_exhausted', day, estimateUsd: Number(estimate), capUsd: Number(cap),
        committedUsd: totals.committedUsd, reservedUsd: totals.reservedUsd, resetsAt: nextUtcMidnight(at) };
    } catch {
      return { ok: false, reason: 'ledger_unavailable', day };
    }
  };

  const dispatch = async (id: string): Promise<boolean> => {
    try {
      const rows = await engine.executeRaw(
        "UPDATE budget_reservations SET status = 'dispatched' WHERE reservation_id = $3 AND scope = $1 AND resolver_id = $2 AND status = 'held' AND expires_at > $4::timestamptz RETURNING 1",
        params(id, now().toISOString()));
      return rows.length === 1;
    } catch { return false; }
  };

  const settle = async (id: string, actualUsd: number): Promise<SettleResult> => {
    const actual = ledgerUsd(actualUsd);
    let row: { prior: ReservationStatus | null; estimate: string | null; day: string | null; current: ReservationStatus | null } | undefined;
    try { [row] = await engine.executeRaw(SETTLE_SQL, params(id, actual)); } catch { return { settled: false, reason: 'ledger_unavailable' }; }
    if (!row?.prior) return row?.current ? { settled: false, reason: 'already_settled', prior: row.current } : { settled: false, reason: 'unknown_reservation' };
    const overrun = Math.max(0, Number(actual) - Number(row.estimate));
    return { settled: true, day: row.day!, actualUsd: Number(actual), overrunUsd: Number(overrun.toFixed(4)), prior: row.prior };
  };

  const release = async (id: string): Promise<boolean> => {
    try { return (await engine.executeRaw(RELEASE_SQL, params(id))).length === 1; } catch { return false; }
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
