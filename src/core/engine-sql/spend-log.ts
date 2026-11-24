/**
 * The spend ledger and the client budget rows behind it: `mcp_spend_log` (one row per settled or recorded paid call) and
 * the spend columns of `oauth_clients` (`budget_usd_per_day`, `scope`, `bound_tools`, `deleted_at`), with the
 * reservation tables of jobs-spend.ts. SQL once for both engines, so a store that is not SQL serves the same members
 * (rust/docs/store/spend-log.md).
 *
 * What is here: the atomic admission of a client hold and of a group hold (`reserveClientSpend`, `reserveGroupSpend`:
 * the lock, the cap read, the sweep, the sums, the refusal and the insert as one unit), the group totals, the settle
 * that also writes the ledger row, the ledger insert and the daily sum, the budget text of one client, the agent spend
 * view of the admin page, and the cap writer of a client row (`updateOauthClientBudget`); the insert and the whole-row
 * read of a client are in oauth-clients.ts. What is not served: the other readers and writers of `oauth_clients`.
 *
 * A function that runs more than one statement takes a transaction (the engine delegates wrap the call in
 * `engine.transaction`). The decisions are made here, with the arithmetic in the same order the callers had it, so the
 * Rust store reaches the same answers. A refusal is an outcome, not a throw: the caller throws its typed error.
 */
import type { BrainEngine } from '../engine.ts';
import { expireSpendReservations, insertSpendReservation, settleSpendReservation } from './jobs-spend.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;
type Tx = Pick<BrainEngine, 'executeRaw' | 'kind'>;

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** FNV-1a 32-bit hash of an owner id, the `pg_advisory_xact_lock` key of its admissions (an unsigned value fits BIGINT). */
export function clientLockKey(clientId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < clientId.length; i++) {
    h ^= clientId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------- client admission

/** One client hold to place: the cap the caller asks for, the day the committed spend is summed over, the hold's fields. */
export interface ClientReserveSpec {
  reservation_id: string;
  client_id: string;
  estimated_cents: number;
  /** The caller's cap; the client's configured cap lowers it. Null admits without a cap of its own. */
  cap_cents: number | null;
  estimate_known: boolean;
  model: string;
  provider: string;
  job_id: number | null;
  expires_at: Date;
  /** Committed spend counts from this instant (the UTC midnight the caller read). */
  day_start: Date;
}

/**
 * What the admission found. `reserved`: the hold is in. `refused`: the cap (or an unknown estimate under a cap) said no,
 * and nothing was inserted. `invalid_cap`: the configured cap is negative. `invalid_total`: a sum is not a finite
 * non-negative number. The sweep of overdue holds ran in every outcome but `invalid_cap`.
 */
export type ClientReserveOutcome =
  | { outcome: 'reserved' }
  | { outcome: 'refused'; committed_cents: number; pending_cents: number; cap_cents: number }
  | { outcome: 'invalid_cap'; cap_cents: number }
  | { outcome: 'invalid_total'; label: string };

/** The cap `oauth_clients.budget_usd_per_day` text (dollars to two decimals) means, in whole cents. */
export function configuredCapCents(text: string | null | undefined): number | null {
  return text == null ? null : Math.round(Number(text) * 100);
}

const finiteTotal = (v: unknown): number | null => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Atomic check-and-reserve for a client. Under the owner's advisory lock (Postgres): read the client's configured cap
 * (the row is share-locked; a client with no row has none), sweep the client's overdue holds, sum the day's committed
 * spend and every unresolved hold, refuse when `committed + pending + estimated` is over the cap (or the estimate is
 * unknown, or an unknown hold is still open, under a cap), else insert the hold.
 */
export async function reserveClientSpend(tx: Tx, spec: ClientReserveSpec): Promise<ClientReserveOutcome> {
  if (tx.kind === 'postgres') {
    // Lock-census (PR6 D5): INTENTIONALLY per-client, not per-source: the budget cap is an oauth_clients.budget_usd_per_day property; one client's concurrent requests must serialize regardless of which source each targets.
    await tx.executeRaw('SELECT pg_advisory_xact_lock($1::bigint)', [String(clientLockKey(spec.client_id))]);
  }
  const clients = await tx.executeRaw<{ cap: string | null }>(
    'SELECT budget_usd_per_day::text AS cap FROM oauth_clients WHERE client_id = $1 FOR SHARE', [spec.client_id]);
  const configured = configuredCapCents(clients[0]?.cap);
  const cap = spec.cap_cents === null ? configured : configured === null ? spec.cap_cents : Math.min(spec.cap_cents, configured);
  if (cap !== null && !(Number.isFinite(cap) && cap >= 0)) return { outcome: 'invalid_cap', cap_cents: cap };

  await expireSpendReservations(tx, { clientId: spec.client_id });

  const rows = await tx.executeRaw<{ committed_text: string; pending_text: string; unknown_count: number | string }>(
    `SELECT
       COALESCE((SELECT SUM(spend_cents)::text FROM mcp_spend_log
                  WHERE client_id = $1 AND created_at >= $2::timestamptz), '0') AS committed_text,
       COALESCE((SELECT SUM(estimated_cents)::text FROM mcp_spend_reservations
                  WHERE client_id = $1 AND status IN ('pending', 'expired')), '0') AS pending_text,
       (SELECT count(*) FROM mcp_spend_reservations
         WHERE client_id = $1 AND status IN ('pending', 'expired') AND estimate_known = false) AS unknown_count`,
    [spec.client_id, spec.day_start.toISOString()]);
  const committed = finiteTotal(rows[0]?.committed_text);
  if (committed === null) return { outcome: 'invalid_total', label: 'committed spend' };
  const pending = finiteTotal(rows[0]?.pending_text);
  if (pending === null) return { outcome: 'invalid_total', label: 'pending spend' };
  const projected = committed + pending + spec.estimated_cents;
  if (cap !== null && (!spec.estimate_known || num(rows[0]?.unknown_count) > 0 || projected > cap)) {
    return { outcome: 'refused', committed_cents: committed, pending_cents: pending, cap_cents: cap };
  }
  await insertSpendReservation(tx, {
    reservation_id: spec.reservation_id, client_id: spec.client_id, budget_key: null, job_id: spec.job_id,
    estimated_cents: spec.estimated_cents, model: spec.model, provider: spec.provider, expires_at: spec.expires_at,
    estimate_known: spec.estimate_known, usage_unknown_reason: spec.estimate_known ? null : 'pricing_or_bound_unknown',
  });
  return { outcome: 'reserved' };
}

// ---------------------------------------------------------------- group admission

/** A group's lifetime totals in cents. Overdue holds count as spent until reconciled. */
export interface GroupSpendRow {
  committed_cents: number;
  overdue_cents: number;
  live_cents: number;
}

/** The raw totals of one budget key: the ledger, the overdue holds (expired, or pending past their deadline), the live holds. */
export async function readGroupSpendTotals(tx: Raw, budgetKey: string): Promise<GroupSpendRow> {
  const rows = await tx.executeRaw<{ committed_text: string; overdue_text: string; live_text: string }>(
    `SELECT
       COALESCE((SELECT SUM(spend_cents)::text FROM mcp_spend_log WHERE budget_key = $1), '0') AS committed_text,
       COALESCE((SELECT SUM(estimated_cents)::text FROM mcp_spend_reservations
                  WHERE budget_key = $1 AND (status = 'expired' OR (status = 'pending' AND expires_at < now()))), '0') AS overdue_text,
       COALESCE((SELECT SUM(estimated_cents)::text FROM mcp_spend_reservations
                  WHERE budget_key = $1 AND status = 'pending' AND expires_at >= now()), '0') AS live_text`,
    [budgetKey]);
  return { committed_cents: Number(rows[0]?.committed_text ?? 0), overdue_cents: Number(rows[0]?.overdue_text ?? 0), live_cents: Number(rows[0]?.live_text ?? 0) };
}

export interface GroupReserveSpec {
  reservation_id: string;
  budget_key: string;
  estimated_cents: number;
  /** Null reserves without a check (the spend is still ledgered). */
  cap_cents: number | null;
  estimate_known: boolean;
  model: string;
  provider: string;
  job_id: number | null;
  expires_at: Date;
}

/**
 * `reserved`: the hold is in, at `estimated_cents` (the ask, bounded by the room left under the cap). `refused`:
 * `exhausted` (the ledger and the overdue holds leave no room) or `pressure` (only live holds are in the way), with the
 * totals read. `invalid_total`: a total is not a finite non-negative number.
 */
export type GroupReserveOutcome =
  | { outcome: 'reserved'; estimated_cents: number }
  | { outcome: 'refused'; kind: 'exhausted' | 'pressure'; committed_cents: number; overdue_cents: number; live_cents: number }
  | { outcome: 'invalid_total'; label: string };

/**
 * Atomic reserve against a command group's shared budget, summed over the group's lifetime: sweep the key's overdue
 * holds; settled spend plus overdue holds at or over the cap is `exhausted`; the hold is bounded by the room left; live
 * holds of concurrent attempts that leave no room are `pressure`. A null cap inserts without a check.
 */
export async function reserveGroupSpend(tx: Tx, spec: GroupReserveSpec): Promise<GroupReserveOutcome> {
  if (tx.kind === 'postgres') {
    // Lock-census (PR6 D5): INTENTIONALLY per budget key: every job of a group shares one total regardless of source.
    await tx.executeRaw('SELECT pg_advisory_xact_lock($1::bigint)', [String(clientLockKey(spec.budget_key))]);
  }
  await expireSpendReservations(tx, { budgetKey: spec.budget_key });
  let estimated = spec.estimated_cents;
  if (spec.cap_cents !== null) {
    const spend = await readGroupSpendTotals(tx, spec.budget_key);
    const checks: Array<[string, number]> = [['committed spend', spend.committed_cents], ['overdue spend', spend.overdue_cents], ['pending spend', spend.live_cents]];
    for (const [label, total] of checks) if (finiteTotal(total) === null) return { outcome: 'invalid_total', label };
    const remaining = spec.cap_cents - spend.committed_cents - spend.overdue_cents;
    const knownFree = estimated === 0 && spec.estimate_known;
    if (remaining < 0 || (remaining === 0 && !knownFree)) return { outcome: 'refused', kind: 'exhausted', ...spend };
    estimated = Math.min(estimated, remaining);
    if (spend.live_cents > 0 && spend.live_cents + estimated > remaining) return { outcome: 'refused', kind: 'pressure', ...spend };
  }
  await insertSpendReservation(tx, {
    reservation_id: spec.reservation_id, client_id: null, budget_key: spec.budget_key, job_id: spec.job_id,
    estimated_cents: estimated, model: spec.model, provider: spec.provider, expires_at: spec.expires_at,
    estimate_known: spec.estimate_known, usage_unknown_reason: spec.estimate_known ? null : 'pricing_or_bound_unknown',
  });
  return { outcome: 'reserved', estimated_cents: estimated };
}

// ---------------------------------------------------------------- settle and the ledger

/** What `settleSpendWithLog` did: settled the hold and wrote its ledger row, found it settled already, or found no such hold. */
export type SettleLogOutcome = { outcome: 'settled' } | { outcome: 'already_settled' } | { outcome: 'missing' };

/**
 * Settle a hold at its actual cents and write the ledger row (the hold's owner, provider and model; the caller's
 * operation and token name) as one unit: a ledger failure leaves the hold unsettled. A settled hold is left alone.
 */
export async function settleSpendWithLog(
  tx: Raw, reservationId: string, actualCents: number, operation: string, tokenName: string | null,
): Promise<SettleLogOutcome> {
  const settled = await settleSpendReservation(tx, reservationId, actualCents);
  if (settled.outcome !== 'settled') return { outcome: settled.outcome };
  await tx.executeRaw(
    `INSERT INTO mcp_spend_log (client_id, budget_key, token_name, operation, spend_cents, provider, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [settled.client_id, settled.budget_key, tokenName, operation, actualCents, settled.provider, settled.model]);
  return { outcome: 'settled' };
}

/** One ledger row of a call that was not reserved (`recordSpend`): its owner is a client or nobody. */
export interface SpendLogInsert {
  client_id: string | null;
  token_name: string | null;
  operation: string;
  spend_cents: number;
  provider: string | null;
  model: string | null;
}

/** `INSERT` one ledger row stamped with the database clock. */
export async function insertSpendLog(tx: Raw, row: SpendLogInsert): Promise<void> {
  await tx.executeRaw(
    `INSERT INTO mcp_spend_log (client_id, token_name, operation, spend_cents, provider, model)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.client_id, row.token_name, row.operation, row.spend_cents, row.provider, row.model]);
}

/** A client's ledger sum from `since` on, in cents (0 with no row). */
export async function sumClientSpendSince(tx: Raw, clientId: string, since: Date): Promise<number> {
  const rows = await tx.executeRaw<{ total: string }>(
    `SELECT COALESCE(SUM(spend_cents), 0)::text AS total FROM mcp_spend_log WHERE client_id = $1 AND created_at >= $2::timestamptz`,
    [clientId, since.toISOString()]);
  return Number(rows[0]?.total ?? 0);
}

// ---------------------------------------------------------------- oauth_clients: the spend columns

/** The client's `budget_usd_per_day` as Postgres prints it (dollars to two decimals), null for no cap or no such client. */
export async function readClientBudgetUsd(tx: Raw, clientId: string): Promise<string | null> {
  const rows = await tx.executeRaw<{ cap: string | null }>(
    'SELECT budget_usd_per_day::text AS cap FROM oauth_clients WHERE client_id = $1', [clientId]);
  return rows[0]?.cap ?? null;
}

// The writer and the whole-row read of a client are in oauth-clients.ts; re-exported for the callers of this file.
export { insertOauthClient, type OauthClientInsert } from './oauth-clients.ts';

/** Set (or clear, with null) a client's daily cap in dollars. Returns whether the client exists. */
export async function updateOauthClientBudget(tx: Raw, clientId: string, usd: number | null): Promise<boolean> {
  const rows = await tx.executeRaw(
    'UPDATE oauth_clients SET budget_usd_per_day = $2 WHERE client_id = $1 RETURNING client_id', [clientId, usd]);
  return rows.length > 0;
}

// ---------------------------------------------------------------- the admin spend view

/** One live agent client's spend today (`/admin/api/agents/spend`). */
export interface AgentClientSpendRow {
  client_id: string;
  client_name: string;
  cap_usd_per_day: number | null;
  spent_cents_today: number;
  pending_cents: number;
  unknown_count: number;
  inflight_count: number;
}

/**
 * Per live client that holds the `agent` scope or is bound to tools: its cap, today's (UTC) ledger sum, its unresolved
 * holds and how many are of unknown usage, and its open `subagent` jobs. By client name, then client id, in byte order (`COLLATE "C"`, as the Rust store sorts).
 */
export async function readAgentClientSpend(tx: Raw): Promise<AgentClientSpendRow[]> {
  const rows = await tx.executeRaw<{
    client_id: string; client_name: string | null; cap_usd_per_day: string | null; spent_cents_today: string | null;
    pending_cents: string | null; unknown_count: number | string | null; inflight_count: number | string | null;
  }>(
    `SELECT
       c.client_id,
       c.client_name,
       c.budget_usd_per_day::text AS cap_usd_per_day,
       COALESCE((
         SELECT SUM(spend_cents)::text
           FROM mcp_spend_log
          WHERE client_id = c.client_id
            -- Double AT TIME ZONE: the inner one yields NAIVE UTC-midnight; the outer one converts it back to a
            -- timestamptz INSTANT. Without it the naive value is reinterpreted in the SESSION timezone, so any non-UTC
            -- session shifts the day boundary by the offset and today's spend underreports every evening.
            AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       ), '0') AS spent_cents_today,
       COALESCE((
         SELECT SUM(estimated_cents)::text FROM mcp_spend_reservations
          WHERE client_id = c.client_id AND status IN ('pending', 'expired')
       ), '0') AS pending_cents,
       (SELECT COUNT(*)::int FROM mcp_spend_reservations
         WHERE client_id = c.client_id AND status IN ('pending', 'expired') AND estimate_known = false) AS unknown_count,
       COALESCE((
         SELECT COUNT(*)::int FROM minion_jobs
          WHERE name = 'subagent'
            AND status IN ('waiting', 'active', 'waiting-children', 'delayed', 'paused')
            AND data->>'__owner_client_id' = c.client_id
       ), 0) AS inflight_count
     FROM oauth_clients c
     WHERE c.deleted_at IS NULL
       AND ('agent' = ANY (string_to_array(c.scope, ' ')) OR c.bound_tools IS NOT NULL)
     ORDER BY c.client_name COLLATE "C" ASC, c.client_id COLLATE "C" ASC`);
  return rows.map(r => ({
    client_id: String(r.client_id),
    client_name: String(r.client_name ?? r.client_id),
    cap_usd_per_day: r.cap_usd_per_day == null ? null : parseFloat(String(r.cap_usd_per_day)),
    spent_cents_today: parseFloat(String(r.spent_cents_today ?? '0')),
    pending_cents: parseFloat(String(r.pending_cents ?? '0')),
    unknown_count: num(r.unknown_count),
    inflight_count: num(r.inflight_count),
  }));
}
