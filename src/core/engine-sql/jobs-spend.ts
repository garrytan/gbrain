/**
 * The spend-reservation and lease-pressure tables of the minion queue: `mcp_spend_reservations` (the holds a paid call
 * places before it runs, and what each settled at) and `minion_lease_pressure_log` (one row per rate-lease bounce).
 * SQL once for both engines, so a store that is not SQL serves the same members (rust/docs/store/jobs-spend.md).
 *
 * What is here: the spend tree `describeJobs` prints, a reservation's insert, the sweep that marks overdue holds
 * expired, the usage-unknown mark, and the lease-pressure insert, count and list. The statements that need
 * `mcp_spend_log` or `oauth_clients` (the admissions, the settle with its ledger row) are in spend-log.ts.
 *
 * Every function takes the transaction (or the engine, for a single statement) it runs on. Rows come back typed:
 * counts and sums as numbers, timestamps as `Date`s.
 */
import type { BrainEngine } from '../engine.ts';
import { joinFragments, renderFragment, sqlFragment, type SqlFragment } from './fragment.ts';
import { jobOwnedFragment, type JobOwnerSpec } from './jobs-queue.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

const num = (v: unknown): number => (v == null ? 0 : Number(v));

// ---------------------------------------------------------------- spend tree

/** What `readJobSpendTree` reads: the described jobs and the owner-fenced caller (GST-4010, `jobOwnedFragment`; null for none). */
export interface JobSpendTreeSpec {
  jobIds: readonly number[];
  owner: JobOwnerSpec | null;
}

/** One described job's spend over one part of its tree: itself (`self`) or its descendants. */
export interface SpendTreeRow {
  root: number;
  self: boolean;
  /** Settled actual cents, null when no priced reservation is in this part. */
  settled_cents: number | null;
  priced: number;
  unsettled: number;
}

/**
 * Per described job, the reservations held by the job (`self`) and by its descendants (to depth 20), as settled cents,
 * the count of priced reservations and the count still unsettled. An owner-fenced caller counts only the descendants
 * it owns. A part with no reservation has no row. By job id, then own part first.
 */
export async function readJobSpendTree(tx: Raw, spec: JobSpendTreeSpec): Promise<SpendTreeRow[]> {
  if (spec.jobIds.length === 0) return [];
  // An unfenced caller owns every row, as `true`; a fenced one owns the rows `jobOwnedFragment` matches.
  const owned = (alias: string): SqlFragment => spec.owner
    ? sqlFragment`COALESCE((${jobOwnedFragment(spec.owner, alias)}), false)` : sqlFragment`true`;
  const { text, params } = renderFragment(sqlFragment`WITH RECURSIVE tree(root, id, owned, depth) AS (
       SELECT s.id, s.id, ${owned('s')}, 0 FROM minion_jobs s WHERE s.id = ANY(${[...spec.jobIds]}::int[])
       UNION ALL
       SELECT t.root, c.id, ${owned('c')}, t.depth + 1 FROM minion_jobs c JOIN tree t ON c.parent_job_id = t.id WHERE t.depth < 20
     )
     SELECT t.root, (t.id = t.root) AS self,
            sum(r.actual_cents) FILTER (WHERE r.status = 'settled' AND r.actual_cents IS NOT NULL) AS settled_cents,
            count(*) FILTER (WHERE r.status = 'settled' AND r.actual_cents IS NOT NULL) AS priced,
            count(*) FILTER (WHERE r.status <> 'settled' OR r.actual_cents IS NULL) AS unsettled
       FROM tree t JOIN mcp_spend_reservations r ON r.job_id = t.id
      WHERE t.id = t.root OR t.owned
      GROUP BY 1, 2 ORDER BY 1, 2`);
  const rows = await tx.executeRaw<{
    root: number | string; self: boolean; settled_cents: number | string | null; priced: number | string; unsettled: number | string;
  }>(text, params);
  return rows.map(r => ({
    root: Number(r.root), self: r.self, settled_cents: r.settled_cents == null ? null : Number(r.settled_cents),
    priced: num(r.priced), unsettled: num(r.unsettled),
  }));
}

// ---------------------------------------------------------------- reservations

/** One new hold. Exactly one of `client_id` and `budget_key` is set (the table's check). */
export interface SpendReservationInsert {
  /** A lowercase hyphenated UUID. */
  reservation_id: string;
  client_id: string | null;
  budget_key: string | null;
  job_id: number | null;
  estimated_cents: number;
  model: string;
  provider: string;
  /** When the hold becomes overdue. */
  expires_at: Date;
  estimate_known: boolean;
  usage_unknown_reason: string | null;
}

/** `INSERT` one `pending` reservation. A job id that names no job, or neither or both owners, is a constraint error. */
export async function insertSpendReservation(tx: Raw, row: SpendReservationInsert): Promise<void> {
  await tx.executeRaw(
    `INSERT INTO mcp_spend_reservations
       (reservation_id, client_id, budget_key, job_id, estimated_cents, model, provider, status, expires_at, estimate_known, usage_unknown_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10)`,
    [row.reservation_id, row.client_id, row.budget_key, row.job_id, row.estimated_cents, row.model, row.provider,
      row.expires_at, row.estimate_known, row.usage_unknown_reason]);
}

/** Which holds `expireSpendReservations` considers: all of them, or those of one client, or of one budget group. */
export interface ExpireSpendScope {
  clientId?: string;
  budgetKey?: string;
}

/**
 * Mark every `pending` reservation past its expiry `expired` (an overdue marker: it stays charged until its usage is
 * known). Returns how many rows were marked.
 */
export async function expireSpendReservations(tx: Raw, scope: ExpireSpendScope = {}): Promise<number> {
  const client = scope.clientId !== undefined ? sqlFragment` AND client_id = ${scope.clientId}` : sqlFragment``;
  const budget = scope.budgetKey !== undefined ? sqlFragment` AND budget_key = ${scope.budgetKey}` : sqlFragment``;
  const { text, params } = renderFragment(
    sqlFragment`UPDATE mcp_spend_reservations SET status = 'expired' WHERE status = 'pending' AND expires_at < now()${client}${budget} RETURNING reservation_id`);
  const rows = await tx.executeRaw(text, params);
  return rows.length;
}

/** What `settleSpendReservation` found: the hold it settled (with what the spend log row needs), one already settled, or none. */
export type SettleSpendOutcome =
  | { outcome: 'settled'; client_id: string | null; budget_key: string | null; model: string; provider: string }
  | { outcome: 'already_settled' }
  | { outcome: 'missing' };

/**
 * Settle a hold at `actualCents`: it becomes `settled` with the actual cents and the settle time, and any unknown-usage
 * reason is cleared. A `pending` or an overdue (`expired`) hold settles (a late result is paid work); a settled one is
 * left alone, so a second call reports `already_settled`.
 */
export async function settleSpendReservation(tx: Raw, reservationId: string, actualCents: number): Promise<SettleSpendOutcome> {
  const updated = await tx.executeRaw<{ client_id: string | null; budget_key: string | null; model: string; provider: string }>(
    `UPDATE mcp_spend_reservations
        SET status = 'settled', actual_cents = $2, usage_unknown_reason = NULL, settled_at = now()
      WHERE reservation_id = $1 AND status IN ('pending', 'expired')
      RETURNING client_id, budget_key, model, provider`, [reservationId, actualCents]);
  if (updated.length > 0) {
    const r = updated[0]!;
    return {
      outcome: 'settled', client_id: r.client_id == null ? null : String(r.client_id),
      budget_key: r.budget_key == null ? null : String(r.budget_key), model: String(r.model), provider: String(r.provider),
    };
  }
  const existing = await tx.executeRaw<{ status: string }>(
    `SELECT status FROM mcp_spend_reservations WHERE reservation_id = $1`, [reservationId]);
  return existing[0]?.status === 'settled' ? { outcome: 'already_settled' } : { outcome: 'missing' };
}

/**
 * Record why a hold's usage is unknown. Only a `pending` or `expired` hold takes it; a settled one keeps its actual
 * cents. Returns whether a row changed.
 */
export async function markSpendUsageUnknown(tx: Raw, reservationId: string, reason: string): Promise<boolean> {
  const rows = await tx.executeRaw(
    `UPDATE mcp_spend_reservations SET usage_unknown_reason = $2
      WHERE reservation_id = $1 AND status IN ('pending','expired') RETURNING reservation_id`, [reservationId, reason]);
  return rows.length > 0;
}

// ---------------------------------------------------------------- lease pressure

/** One rate-lease bounce (`minion_lease_pressure_log`). Optional fields are null when not given. */
export interface LeasePressureInsert {
  /** The bounced job; it must exist. */
  job_id: number;
  lease_key: string;
  active_at_bounce: number;
  max_concurrent: number;
  queue_name?: string | null;
  job_name?: string | null;
  model?: string | null;
  provider?: string | null;
  root_owner_id?: number | null;
}

/** `INSERT` one bounce, stamped with the database clock. */
export async function insertLeasePressure(tx: Raw, row: LeasePressureInsert): Promise<void> {
  await tx.executeRaw(
    `INSERT INTO minion_lease_pressure_log
       (job_id, lease_key, active_at_bounce, max_concurrent, queue_name, job_name, model, provider, root_owner_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [row.job_id, row.lease_key, row.active_at_bounce, row.max_concurrent, row.queue_name ?? null, row.job_name ?? null,
      row.model ?? null, row.provider ?? null, row.root_owner_id ?? null]);
}

/** Which bounces `countLeasePressure` counts: those that match every field given (none given counts them all). */
export interface LeasePressureFilter {
  /** Bounced within the last this many milliseconds. */
  windowMs?: number;
  jobId?: number;
  leaseKey?: string;
}

export async function countLeasePressure(tx: Raw, filter: LeasePressureFilter = {}): Promise<number> {
  const where: SqlFragment[] = [];
  if (filter.windowMs !== undefined) where.push(sqlFragment`bounced_at > now() - (${filter.windowMs}::double precision * interval '1 millisecond')`);
  if (filter.jobId !== undefined) where.push(sqlFragment`job_id = ${filter.jobId}`);
  if (filter.leaseKey !== undefined) where.push(sqlFragment`lease_key = ${filter.leaseKey}`);
  const filtered = where.length > 0 ? sqlFragment` WHERE ${joinFragments(where, ' AND ')}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT count(*)::int AS n FROM minion_lease_pressure_log${filtered}`);
  const [row] = await tx.executeRaw<{ n: number | string }>(text, params);
  return num(row?.n);
}

export interface LeasePressureRow {
  id: number;
  /** Null once the bounced job was pruned. */
  job_id: number | null;
  lease_key: string;
  active_at_bounce: number;
  max_concurrent: number;
  bounced_at: Date;
  queue_name: string | null;
  job_name: string | null;
  model: string | null;
  provider: string | null;
  root_owner_id: number | null;
}

/** The bounces of the last `windowMs` milliseconds, newest first (then highest id), at most `limit`. */
export async function listRecentLeasePressure(tx: Raw, windowMs: number, limit: number): Promise<LeasePressureRow[]> {
  const rows = await tx.executeRaw<Omit<LeasePressureRow, 'bounced_at' | 'id' | 'root_owner_id' | 'job_id'> & {
    id: number | string; job_id: number | string | null; bounced_at: Date | string; root_owner_id: number | string | null;
  }>(
    `SELECT id, job_id, lease_key, active_at_bounce, max_concurrent, bounced_at, queue_name, job_name, model, provider, root_owner_id
       FROM minion_lease_pressure_log
      WHERE bounced_at > now() - ($1::double precision * interval '1 millisecond')
      ORDER BY bounced_at DESC, id DESC
      LIMIT $2`, [windowMs, limit]);
  return rows.map(r => ({
    ...r, id: Number(r.id), job_id: r.job_id == null ? null : Number(r.job_id), bounced_at: new Date(r.bounced_at),
    root_owner_id: r.root_owner_id == null ? null : Number(r.root_owner_id),
  }));
}
