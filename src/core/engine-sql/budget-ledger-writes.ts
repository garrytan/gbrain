/**
 * The daily budget ledger's writes (budget/daily-ledger.ts, the paid-call protocol): reclaim, reserve, dispatch, settle
 * and release over `budget_ledger` and `budget_reservations`, as typed members. Both SQL engines delegate here. The Rust
 * store keeps no budget ledger yet, so the members are not served there (the fence census lane's readBudgetLedgerDay
 * answers no row on Rust for the same reason); the paid tier that calls them stops before them on that engine.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One ledger: a (scope, resolver) pair. */
export interface BudgetLedgerKey { scope: string; resolver: string }

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

const params = (key: BudgetLedgerKey, ...rest: unknown[]) => [key.scope, key.resolver, ...rest];

/** Releases the ledger's expired held reservations and settles its expired dispatched ones at their estimate, as of `nowIso`. */
export async function reclaimBudgetReservations(exec: Raw, key: BudgetLedgerKey, nowIso: string): Promise<{ released: number; uncertain: number }> {
  const [row] = await exec.executeRaw<{ released: number; uncertain: number }>(RECLAIM_SQL, params(key, nowIso));
  return { released: Number(row?.released ?? 0), uncertain: Number(row?.uncertain ?? 0) };
}

/** One reservation to hold: its UTC day, estimate and cap (ledger amounts as text), id and times. */
export interface BudgetReservationSpec { day: string; estimate: string; cap: string; id: string; at: string; expiresAt: string }

/** Holds the reservation when the day's reserved plus committed plus the estimate stays within the cap; true when it was held. */
export async function reserveBudgetReservation(exec: Raw, key: BudgetLedgerKey, spec: BudgetReservationSpec): Promise<boolean> {
  const rows = await exec.executeRaw<{ reservation_id: string }>(RESERVE_SQL, params(key, spec.day, spec.estimate, spec.cap, spec.id, spec.at, spec.expiresAt));
  return rows.length === 1;
}

/** Marks a held, unexpired reservation dispatched; true when it was. */
export async function dispatchBudgetReservation(exec: Raw, key: BudgetLedgerKey, id: string, nowIso: string): Promise<boolean> {
  const rows = await exec.executeRaw(
    "UPDATE budget_reservations SET status = 'dispatched' WHERE reservation_id = $3 AND scope = $1 AND resolver_id = $2 AND status = 'held' AND expires_at > $4::timestamptz RETURNING 1",
    params(key, id, nowIso));
  return rows.length === 1;
}

/** A settle's answer: the prior status, estimate and day of a settled reservation, or only its current status. */
export interface BudgetSettleRow { prior: string | null; estimate: string | null; day: string | null; current: string | null }

/** Settles a reservation at `actual` (a ledger amount as text) and moves the day's totals; the row the protocol reads, if any. */
export async function settleBudgetReservation(exec: Raw, key: BudgetLedgerKey, id: string, actual: string): Promise<BudgetSettleRow | null> {
  const [row] = await exec.executeRaw<BudgetSettleRow>(SETTLE_SQL, params(key, id, actual));
  return row ?? null;
}

/** Releases a held reservation and frees its estimate; true when it was released. */
export async function releaseBudgetReservation(exec: Raw, key: BudgetLedgerKey, id: string): Promise<boolean> {
  return (await exec.executeRaw(RELEASE_SQL, params(key, id))).length === 1;
}
