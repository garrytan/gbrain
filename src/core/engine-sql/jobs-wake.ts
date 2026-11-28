/**
 * The Wakeshift report-back tables (`wake_subscriptions`, `wake_crons`, `wake_cron_runs`, `wake_terms_acceptances`,
 * `wake_forgets`): the watches an agent opens, lists and ends, the cron names an owner registers and the runs they
 * report, the terms a principal accepted, and what the drainer reads and leases to deliver a wake. SQL once for both
 * engines, so a store that is not SQL can serve the same members (rust/docs/store/jobs-wake.md).
 *
 * Every function takes the engine (or transaction) it runs on and returns plain rows: a bigint id is a number, a
 * timestamp a `Date`, a count a number. Windows, limits and lease lengths are arguments or fixed statement text; no
 * statement is built from data. Where a read had no ORDER BY the caller never depended on one, an order is added so the
 * engines agree on it.
 *
 * Left raw on purpose (the Rust engine refuses it loudly): `principalLive` in `wakeshift/drain.ts`, which reads
 * `oauth_clients`, `access_tokens` and the access members the Rust store does not keep. Both halves of
 * `wakeshift/forget.ts` are typed: `forgetWakeMember` and `forgetWakeCredential`.
 */
import type { BrainEngine } from '../engine.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { CRON_FINISHED, JOB_FINISHED, WRITE_SETTLED } from '../wakeshift/events.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

const TERMINAL = "('completed', 'failed', 'dead', 'cancelled')";
const WRITE_TERMINAL = "('failed', 'conflict', 'cancelled')";
// The SQL below splices only constant text (scripts/check-engine-sql-dynamic.ts). The event names are typed against
// the Wakeshift constants, so a rename there fails the typecheck here.
const JOB_EVENT: typeof JOB_FINISHED = 'gbrain.job.finished';
const WRITE_EVENT: typeof WRITE_SETTLED = 'gbrain.write.settled';
const CRON_EVENT: typeof CRON_FINISHED = 'gbrain.cron.finished';
// An instant in epoch microseconds, as text: the exact token a lease or a cursor compares against.
const CREATED_US = '(floor(extract(epoch FROM w.created_at) * 1000000))::bigint::text';
const FINISHED_US = '(floor(extract(epoch FROM j.finished_at) * 1000000))::bigint::text';
const SETTLED_US = '(floor(extract(epoch FROM COALESCE(r.completed_at, r.updated_at)) * 1000000))::bigint::text';

export type WakePrincipalKind = 'oauth_client' | 'legacy_token' | 'local_stdio';

/** One watch to record: the row `openWakeWatch` inserts (state open, no attempts, due at once). */
export interface WakeWatchInsert {
  event: string;
  target: string;
  targetRef: string | null;
  principalKind: WakePrincipalKind;
  principalId: string;
  memberId: string | null;
  wakeUser: string;
  wsSubscriptionId: string;
  /** An ISO instant (`Date#toISOString`). */
  expiresAt: string;
}

/**
 * Record a watch and return its id. A second open watch of the same (`wakeUser`, `wsSubscriptionId`) pair is the same
 * watch: it keeps its row, takes the new expiry and returns the existing id (`ON CONFLICT ... DO UPDATE`).
 */
export async function openWakeWatch(tx: Raw, w: WakeWatchInsert): Promise<number> {
  const [row] = await tx.executeRaw<{ id: number | string }>(
    `INSERT INTO wake_subscriptions (event, target, target_ref, principal_kind, principal_id, member_id, wake_user, ws_subscription_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
     ON CONFLICT (wake_user, ws_subscription_id) WHERE state = 'open'
     DO UPDATE SET expires_at = EXCLUDED.expires_at, updated_at = now()
     RETURNING id`,
    [w.event, w.target, w.targetRef, w.principalKind, w.principalId, w.memberId, w.wakeUser, w.wsSubscriptionId, w.expiresAt]);
  return Number(row!.id);
}

/**
 * The watches one principal (kind, id and bound member, a NULL member matching a NULL member) holds, newest first, at
 * most 50. `scope` 'open_or_recent' is the open ones plus any updated in the last day (`list_watches`); 'open' is the
 * open ones. `event` with `target`, or `id`, narrows it to one target (`unwatch`).
 */
export interface WakeWatchFilter {
  principalKind: WakePrincipalKind;
  principalId: string;
  memberId: string | null;
  scope: 'open_or_recent' | 'open';
  event?: string;
  target?: string;
  id?: number;
}

export interface WakeWatchRow {
  id: number;
  event: string;
  target: string;
  state: string;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  expires_at: Date;
  wake_user: string;
  ws_subscription_id: string;
}

export async function listWakeWatches(tx: Raw, f: WakeWatchFilter): Promise<WakeWatchRow[]> {
  const scope = trustedSql(f.scope === 'open' ? "AND state = 'open'" : "AND (state = 'open' OR updated_at > now() - interval '1 day')");
  const pick = f.id !== undefined
    ? sqlFragment` AND id = ${f.id}`
    : f.event !== undefined && f.target !== undefined
      ? sqlFragment` AND event = ${f.event} AND target = ${f.target}`
      : sqlFragment` `;
  const { text, params } = renderFragment(sqlFragment`SELECT id, event, target, state, attempts, last_error, created_at, expires_at, wake_user, ws_subscription_id FROM wake_subscriptions
      WHERE principal_kind = ${f.principalKind} AND principal_id = ${f.principalId} AND member_id IS NOT DISTINCT FROM ${f.memberId} ${scope}${pick}
      ORDER BY wake_subscriptions.created_at DESC, wake_subscriptions.id DESC LIMIT 50`);
  const rows = await tx.executeRaw<Omit<WakeWatchRow, 'id'> & { id: number | string }>(text, params);
  return rows.map(r => ({ ...r, id: Number(r.id), attempts: Number(r.attempts) }));
}

/** A watch that was just ended: what ending it at Wakeshift needs. */
export interface EndedWakeWatch { id: number; wake_user: string; ws_subscription_id: string }

/**
 * End open watches and return the rows that ended (a row already ended or delivered is not one of them):
 * 'disabled' every open watch (reporting back was turned off), 'expired' the open ones past `expires_at`, 'unwatched'
 * the open watch `id`. Each sets `last_error` to the reason; 'disabled' and 'unwatched' also drop the lease, 'expired'
 * leaves it.
 */
export type EndWakeWatches = { reason: 'disabled' } | { reason: 'expired' } | { reason: 'unwatched'; id: number };

export async function endWakeWatches(tx: Raw, spec: EndWakeWatches): Promise<EndedWakeWatch[]> {
  type Row = { id: number | string; wake_user: string; ws_subscription_id: string };
  let rows: Row[];
  if (spec.reason === 'disabled') {
    rows = await tx.executeRaw<Row>(
      `UPDATE wake_subscriptions SET state = 'ended', last_error = 'disabled', lease_until = NULL, updated_at = now() WHERE state = 'open'
       RETURNING id, wake_user, ws_subscription_id`);
  } else if (spec.reason === 'expired') {
    rows = await tx.executeRaw<Row>(
      `UPDATE wake_subscriptions SET state = 'ended', last_error = 'expired', updated_at = now()
        WHERE state = 'open' AND expires_at < now() RETURNING id, wake_user, ws_subscription_id`);
  } else {
    rows = await tx.executeRaw<Row>(
      `UPDATE wake_subscriptions SET state = 'ended', last_error = 'unwatched', lease_until = NULL, updated_at = now()
        WHERE id = $1 AND state = 'open' RETURNING id, wake_user, ws_subscription_id`, [spec.id]);
  }
  return rows.map(r => ({ id: Number(r.id), wake_user: r.wake_user, ws_subscription_id: r.ws_subscription_id }));
}

/** Every watch counted by state and last error (`gbrain wakeshift status`), in bytewise order with a NULL error last. */
export async function countWakeWatches(tx: Raw): Promise<Array<{ state: string; last_error: string | null; n: number }>> {
  const rows = await tx.executeRaw<{ state: string; last_error: string | null; n: number | string }>(
    `SELECT state, last_error, count(*)::int AS n FROM wake_subscriptions GROUP BY state, last_error
      ORDER BY state COLLATE "C", last_error COLLATE "C"`);
  return rows.map(r => ({ state: r.state, last_error: r.last_error, n: Number(r.n) }));
}

/** What the doctor's wakeshift check reads: the 7-day watch counts and the cron and forget signals. */
export interface WakeDoctorRead {
  /** Open watches and those updated in the last 7 days, by state and whether the last error was `id_reused` (null: no error). */
  watches: Array<{ state: string; id_reused: boolean | null; n: number }>;
  /** Cron names that reported a run in the last 7 days and are not registered, bytewise. */
  unregistered: string[];
  /** Pending forgets created more than a day ago. */
  stale_forgets: number;
  /** Forgets that died, updated in the last 30 days. */
  dead_forgets: number;
}

export async function readWakeDoctor(tx: Raw): Promise<WakeDoctorRead> {
  const watches = await tx.executeRaw<{ state: string; id_reused: boolean | null; n: number | string }>(
    `SELECT state, (last_error = 'id_reused') AS id_reused, count(*)::int AS n FROM wake_subscriptions
      WHERE state = 'open' OR updated_at > now() - interval '7 days' GROUP BY 1, 2
      ORDER BY state COLLATE "C", id_reused`);
  const [extra] = await tx.executeRaw<{ unregistered: string[] | null; stale_forgets: number | string; dead_forgets: number | string }>(
    `SELECT (SELECT array_agg(DISTINCT r.name COLLATE "C" ORDER BY r.name COLLATE "C") FROM wake_cron_runs r
              WHERE r.finished_at > now() - interval '7 days' AND NOT EXISTS (SELECT 1 FROM wake_crons c WHERE c.name = r.name)) AS unregistered,
            (SELECT count(*)::int FROM wake_forgets WHERE state = 'pending' AND created_at < now() - interval '1 day') AS stale_forgets,
            (SELECT count(*)::int FROM wake_forgets WHERE state = 'dead' AND updated_at > now() - interval '30 days') AS dead_forgets`);
  return {
    watches: watches.map(r => ({ state: r.state, id_reused: r.id_reused, n: Number(r.n) })),
    unregistered: extra?.unregistered ?? [],
    stale_forgets: Number(extra?.stale_forgets ?? 0),
    dead_forgets: Number(extra?.dead_forgets ?? 0),
  };
}

/** Wakeshift forgets still waiting to be sent. */
export async function countPendingWakeForgets(tx: Raw): Promise<number> {
  const [row] = await tx.executeRaw<{ n: number | string }>("SELECT count(*)::int AS n FROM wake_forgets WHERE state = 'pending'");
  return Number(row?.n ?? 0);
}

export interface WakeCronRow { name: string; created_at: Date; last_status: string | null; last_finished_at: Date | null }

/** The registered crons by name (bytewise) with the status and time of each one's last reported run. */
export async function listWakeCrons(tx: Raw): Promise<WakeCronRow[]> {
  return tx.executeRaw<WakeCronRow>(
    `SELECT c.name, c.created_at, r.status AS last_status, r.finished_at AS last_finished_at FROM wake_crons c
      LEFT JOIN LATERAL (SELECT status, finished_at FROM wake_cron_runs WHERE name = c.name ORDER BY finished_at DESC, id DESC LIMIT 1) r ON true
      ORDER BY c.name COLLATE "C"`);
}

/** Register a cron name; a name already registered stays as it is. */
export async function addWakeCron(tx: Raw, name: string): Promise<void> {
  await tx.executeRaw('INSERT INTO wake_crons (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
}

/** Unregister a cron name and end the open watches on it (`last_error` cron_removed); returns the watches that ended. */
export async function removeWakeCron(tx: Raw, name: string): Promise<EndedWakeWatch[]> {
  await tx.executeRaw('DELETE FROM wake_crons WHERE name = $1', [name]);
  const rows = await tx.executeRaw<{ id: number | string; wake_user: string; ws_subscription_id: string }>(
    `UPDATE wake_subscriptions SET state = 'ended', last_error = 'cron_removed', lease_until = NULL, updated_at = now()
      WHERE state = 'open' AND event = $1 AND target = $2 RETURNING id, wake_user, ws_subscription_id`, [CRON_FINISHED, name]);
  return rows.map(r => ({ id: Number(r.id), wake_user: r.wake_user, ws_subscription_id: r.ws_subscription_id }));
}

/** Whether a cron name is registered. */
export async function hasWakeCron(tx: Raw, name: string): Promise<boolean> {
  return (await tx.executeRaw('SELECT 1 FROM wake_crons WHERE name = $1', [name])).length > 0;
}

/**
 * Record one cron run, drop that cron's runs older than 30 days, and say whether the name is registered. A run with a
 * `finishedAt` (a spooled one) is skipped when the same name, status and time are already recorded; a run without one
 * finishes now.
 */
export async function recordWakeCronRun(tx: Raw, run: { name: string; status: string; finishedAt: string | null }): Promise<{ registered: boolean }> {
  await tx.executeRaw(
    `INSERT INTO wake_cron_runs (name, status, finished_at) SELECT $1, $2, COALESCE($3::timestamptz, now())
      WHERE $3::timestamptz IS NULL OR NOT EXISTS (SELECT 1 FROM wake_cron_runs WHERE name = $1 AND status = $2 AND finished_at = $3::timestamptz)`,
    [run.name, run.status, run.finishedAt]);
  await tx.executeRaw("DELETE FROM wake_cron_runs WHERE name = $1 AND finished_at < now() - interval '30 days'", [run.name]);
  return { registered: await hasWakeCron(tx, run.name) };
}

/** Whether a principal key accepted this terms version. */
export async function hasWakeTermsAcceptance(tx: Raw, principalKey: string, termsVersion: string): Promise<boolean> {
  const rows = await tx.executeRaw('SELECT 1 FROM wake_terms_acceptances WHERE principal_key = $1 AND terms_version = $2', [principalKey, termsVersion]);
  return rows.length > 0;
}

/** Record an acceptance; one already recorded stays as it is. */
export async function recordWakeTermsAcceptance(tx: Raw, principalKey: string, termsVersion: string): Promise<void> {
  await tx.executeRaw(
    'INSERT INTO wake_terms_acceptances (principal_key, terms_version) VALUES ($1, $2) ON CONFLICT (principal_key, terms_version) DO NOTHING',
    [principalKey, termsVersion]);
}

/**
 * One due watch joined to what it watches, as the drainer reads it. Each event family fills its own columns and leaves
 * the others null: `job_*` for `gbrain.job.finished`, `req_*` for `gbrain.write.settled`, `run_*` for
 * `gbrain.cron.finished`. A `*_us` field is an instant in epoch microseconds as text, so no driver rounds it.
 */
export interface WakeRow {
  id: number;
  event: string;
  target: string;
  target_ref: string | null;
  principal_kind: WakePrincipalKind;
  principal_id: string;
  member_id: string | null;
  wake_user: string;
  ws_subscription_id: string;
  attempts: number;
  created_us: string;
  job_id: number | null;
  job_name: string | null;
  job_status: string | null;
  /** GST-4010: the watcher submitted the job, or is a local stdio watch (the job owner fence at delivery time). */
  job_visible: boolean | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  finished_us: string | null;
  req_id: string | null;
  req_state: string | null;
  req_operation: string | null;
  req_source_id: string | null;
  req_created_at: Date | string | null;
  req_settled_at: Date | string | null;
  req_settled_us: string | null;
  run_id: number | string | null;
  run_status: string | null;
  run_finished_at: Date | string | null;
}

/** At most this many watches a pass: the drain batch of `wakeshift/drain.ts`. */
export const WAKE_DUE_LIMIT = 20;
const DUE_LIMIT_SQL: `${typeof WAKE_DUE_LIMIT}` = '20';

/**
 * Open, due, unleased watches whose target settled, one row per watch across the three event families (each LEFT JOIN
 * matches only its own event), at most 20, by due time then id; `ids` keeps only those watches.
 */
export async function listDueWakeWatches(tx: Raw, spec: { ids?: readonly number[] } = {}): Promise<WakeRow[]> {
  const byId = spec.ids !== undefined;
  const rows = await tx.executeRaw<WakeRow>(
    `SELECT w.id, w.event, w.target, w.target_ref, w.principal_kind, w.principal_id, w.member_id, w.wake_user, w.ws_subscription_id, w.attempts,
       ${CREATED_US} AS created_us,
       j.id AS job_id, j.name AS job_name, j.status AS job_status, j.started_at, j.finished_at, ${FINISHED_US} AS finished_us,
       (w.principal_kind = 'local_stdio'
         OR (((j.submission_authority->'principal'->>'kind' = w.principal_kind AND j.submission_authority->'principal'->>'id' = w.principal_id)
              OR (j.submission_authority->'principal' IS NULL AND w.principal_kind = 'oauth_client' AND j.data->>'__owner_client_id' = w.principal_id))
             AND COALESCE(j.submission_authority->'grant'->'actor'->>'system', '') = '' AND COALESCE(j.submission_authority->'grant'->'actor'->>'external_id', '') = ''
             AND COALESCE(j.submission_authority->'grant'->'actor'->>'member', '') = '' AND j.submission_authority->'grant'->'actingFor' IS NULL)) IS TRUE AS job_visible,
       r.id::text AS req_id, r.state AS req_state, r.operation AS req_operation, r.source_id AS req_source_id, r.created_at AS req_created_at,
       COALESCE(r.completed_at, r.updated_at) AS req_settled_at, ${SETTLED_US} AS req_settled_us,
       c.id AS run_id, c.status AS run_status, c.finished_at AS run_finished_at
  FROM wake_subscriptions w
  LEFT JOIN minion_jobs j ON w.event = '${JOB_EVENT}' AND j.id = CASE WHEN w.event = '${JOB_EVENT}' AND w.target ~ '^[0-9]{1,18}$' THEN w.target::bigint END
  LEFT JOIN persistence_requests r ON w.event = '${WRITE_EVENT}'
       AND r.id = CASE WHEN w.event = '${WRITE_EVENT}' AND w.target_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN w.target_ref::uuid END
  LEFT JOIN LATERAL (SELECT cr.id, cr.status, cr.finished_at FROM wake_cron_runs cr
       WHERE w.event = '${CRON_EVENT}' AND cr.name = w.target AND cr.finished_at >= w.created_at ORDER BY cr.finished_at, cr.id LIMIT 1) c ON true
 WHERE w.state = 'open' AND w.next_attempt_at <= now() AND (w.lease_until IS NULL OR w.lease_until < now())
   AND CASE w.event
     WHEN '${JOB_EVENT}' THEN (j.id IS NULL OR j.status IN ${TERMINAL})
     WHEN '${WRITE_EVENT}' THEN (r.id IS NULL OR r.state IN ${WRITE_TERMINAL} OR (r.state = 'committed' AND r.recovery IS NULL))
     WHEN '${CRON_EVENT}' THEN c.id IS NOT NULL
     ELSE false END
   ${byId ? 'AND w.id = ANY($1::bigint[])' : ''}
 ORDER BY w.next_attempt_at, w.id
 LIMIT ${DUE_LIMIT_SQL}`, byId ? [spec.ids] : []);
  return rows.map(r => ({
    ...r,
    id: Number(r.id),
    attempts: Number(r.attempts),
    job_id: r.job_id == null ? null : Number(r.job_id),
    run_id: r.run_id == null ? null : Number(r.run_id),
  }));
}

/**
 * Lease one open, due watch for `leaseSeconds`. Returns the lease's instant in epoch microseconds (text, the token
 * `settleWakeWatch` must match) and the row's current attempts, or null when it is not open, not due or leased.
 */
export async function claimWakeWatch(tx: Raw, id: number, leaseSeconds: number): Promise<{ lease: string; attempts: number } | null> {
  const rows = await tx.executeRaw<{ lease: string; attempts: number | string }>(
    `UPDATE wake_subscriptions SET lease_until = now() + make_interval(secs => $2::int), updated_at = now()
      WHERE id = $1 AND state = 'open' AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
      RETURNING (floor(extract(epoch FROM lease_until) * 1000000))::bigint::text AS lease, attempts`, [id, leaseSeconds]);
  return rows[0] ? { lease: rows[0].lease, attempts: Number(rows[0].attempts) } : null;
}

/** How a leased watch settles: its new state and the fields that change with it (a null or absent field keeps the column). */
export interface WakeWatchSettle {
  id: number;
  lease: string;
  state: 'open' | 'delivered' | 'dead' | 'ended';
  marker?: string | null;
  attempts?: number | null;
  /** The seconds until the next attempt; absent keeps `next_attempt_at`. */
  delayS?: number | null;
  /** The new `last_error`; absent or null clears it. */
  error?: string | null;
}

/** Settle a leased watch; false when it was ended (unwatch, disable, expiry) or re-leased meanwhile, which then wins. */
export async function settleWakeWatch(tx: Raw, s: WakeWatchSettle): Promise<boolean> {
  const rows = await tx.executeRaw(
    `UPDATE wake_subscriptions SET state = $2, lease_until = NULL, updated_at = now(),
        delivered_marker = COALESCE($3, delivered_marker), attempts = COALESCE($4, attempts),
        next_attempt_at = CASE WHEN $5::int IS NULL THEN next_attempt_at ELSE now() + make_interval(secs => $5::int) END,
        last_error = $6
      WHERE id = $1 AND state = 'open' AND (floor(extract(epoch FROM lease_until) * 1000000))::bigint::text = $7 RETURNING id`,
    [s.id, s.state, s.marker ?? null, s.attempts ?? null, s.delayS ?? null, s.error ?? null, s.lease]);
  return rows.length > 0;
}

/**
 * Queue a Wakeshift forget of `wakeUser`, unless one is already pending for it. With a `memberId` it queues only when
 * that member is not tombstoned (a removed member's own removal queues it; a live member's user outlives a credential).
 */
export async function queueWakeForget(tx: Raw, wakeUser: string, memberId: string | null): Promise<void> {
  await tx.executeRaw(
    `INSERT INTO wake_forgets (wake_user) SELECT $1
      WHERE $2::text IS NULL OR NOT EXISTS (SELECT 1 FROM access_members WHERE id = $2 AND tombstoned_at IS NULL)
      ON CONFLICT (wake_user) WHERE state = 'pending' DO NOTHING`, [wakeUser, memberId]);
}

/**
 * The three statements of `forgetWakeMember`, each one literal: queue a forget of every user the member watched under
 * (any state, once while one is pending), end the member's open watches, and drop its terms acceptances. The text is
 * what `wakeshift/forget.ts` sent through `executeRaw` before it was a typed member.
 */
export const FORGET_WAKE_MEMBER_SQL = {
  queue: `INSERT INTO wake_forgets (wake_user) SELECT DISTINCT wake_user FROM wake_subscriptions WHERE member_id = $1
        ON CONFLICT (wake_user) WHERE state = 'pending' DO NOTHING RETURNING id`,
  end: `UPDATE wake_subscriptions SET state = 'ended', last_error = 'principal_revoked', lease_until = NULL, updated_at = now()
        WHERE member_id = $1 AND state = 'open' RETURNING id`,
  terms: 'DELETE FROM wake_terms_acceptances WHERE principal_key = $1',
} as const;

/**
 * A removed member's Wakeshift state (plan D6): queue a forget of each user it watched under, end its open watches
 * (`principal_revoked`, lease dropped) and delete the acceptances of `member:<id>`. Returns how many forgets were
 * queued and how many watches ended.
 */
export async function forgetWakeMember(tx: Raw, memberId: string): Promise<{ ended: number; queued: number }> {
  const queued = await tx.executeRaw(FORGET_WAKE_MEMBER_SQL.queue, [memberId]);
  const ended = await tx.executeRaw(FORGET_WAKE_MEMBER_SQL.end, [memberId]);
  await tx.executeRaw(FORGET_WAKE_MEMBER_SQL.terms, [`member:${memberId}`]);
  return { ended: ended.length, queued: queued.length };
}

/**
 * The statements `wakeshift/forget.ts` ran for a revoked token or a deleted OAuth client, byte for byte: $1 is the
 * principal kind and $2 its id in `queue` and `end`; `terms` binds `<kind>:<id>`. Only the watches with no member
 * queue a forget (a member's user outlives one credential), while every open watch of the credential ends.
 */
export const FORGET_WAKE_CREDENTIAL_SQL = {
  queue: `INSERT INTO wake_forgets (wake_user) SELECT DISTINCT wake_user FROM wake_subscriptions
      WHERE principal_kind = $1 AND principal_id = $2 AND member_id IS NULL
      ON CONFLICT (wake_user) WHERE state = 'pending' DO NOTHING RETURNING id`,
  end: `UPDATE wake_subscriptions SET state = 'ended', last_error = 'principal_revoked', lease_until = NULL, updated_at = now()
      WHERE principal_kind = $1 AND principal_id = $2 AND state = 'open' RETURNING id`,
  terms: 'DELETE FROM wake_terms_acceptances WHERE principal_key = $1',
} as const;

/** A credential whose Wakeshift state a revoke or a client delete forgets. */
export type WakeCredentialKind = 'oauth_client' | 'legacy_token';

/**
 * A revoked token's or a deleted OAuth client's Wakeshift state (plan D6): queue a forget of each user its member-less
 * watches ran under, end its open watches (`principal_revoked`, lease dropped) and delete the acceptances of
 * `<kind>:<id>`. A token id is matched in lower case, the form its watches store. Returns how many forgets were queued
 * and how many watches ended.
 */
export async function forgetWakeCredential(tx: Raw, kind: WakeCredentialKind, id: string): Promise<{ ended: number; queued: number }> {
  const principalId = kind === 'legacy_token' ? id.toLowerCase() : id;
  const queued = await tx.executeRaw(FORGET_WAKE_CREDENTIAL_SQL.queue, [kind, principalId]);
  const ended = await tx.executeRaw(FORGET_WAKE_CREDENTIAL_SQL.end, [kind, principalId]);
  await tx.executeRaw(FORGET_WAKE_CREDENTIAL_SQL.terms, [`${kind}:${principalId}`]);
  return { ended: ended.length, queued: queued.length };
}

export interface WakeForgetClaim { id: number; wake_user: string; attempts: number; lease: string }

/** Lease up to `limit` due pending forgets for `leaseSeconds`; each carries the lease token `settleWakeForget` must match. The order of the rows is not specified. */
export async function claimWakeForgets(tx: Raw, spec: { leaseSeconds: number; limit: number }): Promise<WakeForgetClaim[]> {
  const rows = await tx.executeRaw<{ id: number | string; wake_user: string; attempts: number | string; lease: string }>(
    `UPDATE wake_forgets SET lease_until = now() + make_interval(secs => $1::int), updated_at = now()
      WHERE id IN (SELECT id FROM wake_forgets WHERE state = 'pending' AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
                    ORDER BY next_attempt_at, id LIMIT $2)
        AND state = 'pending' AND (lease_until IS NULL OR lease_until < now())
      RETURNING id, wake_user, attempts, (floor(extract(epoch FROM lease_until) * 1000000))::bigint::text AS lease`, [spec.leaseSeconds, spec.limit]);
  return rows.map(r => ({ id: Number(r.id), wake_user: r.wake_user, attempts: Number(r.attempts), lease: r.lease }));
}

export interface WakeForgetSettle {
  id: number;
  lease: string;
  state: 'pending' | 'done' | 'dead';
  attempts: number;
  error: string | null;
  /** The seconds until the next attempt; absent keeps `next_attempt_at`. */
  delayS?: number | null;
}

/** Settle a leased forget; false when it is no longer pending or its lease is not `lease`. */
export async function settleWakeForget(tx: Raw, s: WakeForgetSettle): Promise<boolean> {
  const rows = await tx.executeRaw(
    `UPDATE wake_forgets SET state = $2, attempts = $3, last_error = $4, lease_until = NULL, updated_at = now(),
        next_attempt_at = CASE WHEN $5::int IS NULL THEN next_attempt_at ELSE now() + make_interval(secs => $5::int) END
      WHERE id = $1 AND state = 'pending' AND (floor(extract(epoch FROM lease_until) * 1000000))::bigint::text = $6 RETURNING id`,
    [s.id, s.state, s.attempts, s.error, s.delayS ?? null, s.lease]);
  return rows.length > 0;
}
