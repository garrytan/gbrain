/**
 * Wake delivery by pull reconciliation (plan D7). No outbox and no hook in the
 * job queue: jobs reach a terminal state in many places and
 * `remove_on_complete` deletes rows, so the drainer joins open watches to
 * `minion_jobs` instead and emits when a job's terminal marker
 * (`<finished_us>:<status>`, or `gone`) differs from what the watch
 * delivered. It runs on a 5 s timer inside `gbrain serve` (stdio and HTTP) and
 * the job worker, once more at the end of `gbrain jobs work`, and inside
 * watch_job for a job that already finished.
 *
 * Bounded: at most 20 rows a tick; a lease (conditional UPDATE) so two hosts
 * never emit one row; 5 attempts backing off 30 s, 2 m, 8 m, 30 m (a 429 waits
 * its Retry-After within the same cap); any other 4xx is final. A dead,
 * revoked or expired watch is ended at Wakeshift once, so the conversation is
 * told. Off or keyless: the tick returns before touching the database. A brain
 * with live access members sends nothing (watch_job refuses there too).
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { memberIdentityFor } from '../access/caller.ts';
import { WakeshiftError, type WakeshiftApi } from './client.ts';
import { wakeshiftRuntime } from './config.ts';
import { JOB_FINISHED, jobMarker, jobWake, wakeEmitId, type JobSnapshot } from './events.ts';

export const WAKE_RETRY_SCHEDULE_S = [30, 120, 480, 1800] as const;
export const WAKE_MAX_ATTEMPTS = 5;
export const WAKE_DRAIN_BATCH = 20;
export const WAKE_DRAIN_TICK_MS = 5_000;
const LEASE_S = 60;
const TERMINAL = `('completed', 'failed', 'dead', 'cancelled')`;

export interface WakeRow {
  id: number;
  event: string;
  target: string;
  principal_kind: 'oauth_client' | 'legacy_token' | 'local_stdio';
  principal_id: string;
  member_id: string | null;
  wake_user: string;
  ws_subscription_id: string;
  attempts: number;
  created_us: string;
  job_id: number | null;
  job_name: string | null;
  job_status: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  finished_us: string | null;
}

export interface DrainReport { delivered: number; retried: number; dead: number; ended: number; skipped?: 'off' | 'shared' }

const CANDIDATES_SQL = (byId: boolean) => `
SELECT w.id, w.event, w.target, w.principal_kind, w.principal_id, w.member_id, w.wake_user, w.ws_subscription_id, w.attempts,
       (floor(extract(epoch FROM w.created_at) * 1000000))::bigint::text AS created_us,
       j.id AS job_id, j.name AS job_name, j.status AS job_status, j.started_at, j.finished_at,
       (floor(extract(epoch FROM j.finished_at) * 1000000))::bigint::text AS finished_us
  FROM wake_subscriptions w
  LEFT JOIN minion_jobs j ON w.event = '${JOB_FINISHED}' AND j.id = CASE WHEN w.target ~ '^[0-9]{1,18}$' THEN w.target::bigint END
 WHERE w.state = 'open' AND w.next_attempt_at <= now() AND (w.lease_until IS NULL OR w.lease_until < now())
   AND (j.id IS NULL OR j.status IN ${TERMINAL})
   AND w.delivered_marker IS DISTINCT FROM CASE WHEN j.id IS NULL THEN 'gone' ELSE
       COALESCE((floor(extract(epoch FROM j.finished_at) * 1000000))::bigint::text, '0') || ':' || j.status END
   ${byId ? 'AND w.id = ANY($1::bigint[])' : ''}
 ORDER BY w.next_attempt_at, w.id
 LIMIT ${WAKE_DRAIN_BATCH}`;

/**
 * Lease one open, due row. Returns the lease's timestamp in epoch microseconds (text, so no driver rounds it), the
 * token settle() must match, and the row's current attempts: the candidate snapshot may be stale by now.
 */
async function claim(engine: BrainEngine, id: number): Promise<{ lease: string; attempts: number } | null> {
  const rows = await engine.executeRaw<{ lease: string; attempts: number }>(
    `UPDATE wake_subscriptions SET lease_until = now() + interval '${LEASE_S} seconds', updated_at = now()
      WHERE id = $1 AND state = 'open' AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
      RETURNING (floor(extract(epoch FROM lease_until) * 1000000))::bigint::text AS lease, attempts`, [id]);
  return rows[0] ? { lease: rows[0].lease, attempts: Number(rows[0].attempts) } : null;
}

/** Settle a leased row; false when it was ended (unwatch, disable, expiry) or re-leased meanwhile, which then wins. */
async function settle(engine: BrainEngine, id: number, lease: string, state: 'open' | 'delivered' | 'dead' | 'ended', fields: { marker?: string; attempts?: number; delayS?: number; error?: string | null }): Promise<boolean> {
  const rows = await engine.executeRaw(
    `UPDATE wake_subscriptions SET state = $2, lease_until = NULL, updated_at = now(),
        delivered_marker = COALESCE($3, delivered_marker), attempts = COALESCE($4, attempts),
        next_attempt_at = CASE WHEN $5::int IS NULL THEN next_attempt_at ELSE now() + make_interval(secs => $5::int) END,
        last_error = $6
      WHERE id = $1 AND state = 'open' AND (floor(extract(epoch FROM lease_until) * 1000000))::bigint::text = $7 RETURNING id`,
    [id, state, fields.marker ?? null, fields.attempts ?? null, fields.delayS ?? null, fields.error ?? null, lease]);
  return rows.length > 0;
}

/** Live access members: reporting back runs only on a brain that serves its owner alone (docs/guides/wakeshift.md#who-it-is-for). */
export async function liveAccessMembers(engine: BrainEngine): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM access_members WHERE disabled_at IS NULL AND tombstoned_at IS NULL');
  return Number(row?.n ?? 0);
}

function retryDelayS(attempts: number, err?: WakeshiftError): number {
  const cap = WAKE_RETRY_SCHEDULE_S[WAKE_RETRY_SCHEDULE_S.length - 1];
  if (err?.status === 429 && err.retryAfterS !== undefined) return Math.min(cap, Math.max(1, Math.ceil(err.retryAfterS)));
  return WAKE_RETRY_SCHEDULE_S[attempts - 1] ?? cap;
}

/** GST-363: the local_stdio principal id of a watch from a stdio server started with --stdio-member. */
export const STDIO_REGISTRATION_PRINCIPAL = 'registration';

/** The subscribing credential still exists and, when it was bound to a member, that member is still live. */
export async function principalLive(engine: BrainEngine, row: Pick<WakeRow, 'principal_kind' | 'principal_id' | 'member_id'>): Promise<boolean> {
  if (row.principal_kind === 'oauth_client') {
    const live = await engine.executeRaw('SELECT 1 FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL', [row.principal_id]);
    if (live.length === 0) return false;
  } else if (row.principal_kind === 'legacy_token') {
    const live = await engine.executeRaw('SELECT 1 FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL', [row.principal_id]);
    if (live.length === 0) return false;
  }
  if (!row.member_id) return true;
  // GST-363: a watch from a stdio server started with --stdio-member re-checks that member, not config mcp.stdio_member.
  const registered = row.principal_kind === 'local_stdio' && row.principal_id === STDIO_REGISTRATION_PRINCIPAL;
  const identity = await memberIdentityFor(engine, { principal: { kind: row.principal_kind, id: row.principal_id }, ...(registered ? { stdioMember: row.member_id } : {}) });
  return identity.includes(`member:${row.member_id}`);
}

/** End a watch at Wakeshift once (best effort: the conversation is told; a failure leaves Wakeshift's own ttl to end it). */
export async function endAtWakeshift(api: WakeshiftApi, row: Pick<WakeRow, 'wake_user' | 'ws_subscription_id'>): Promise<boolean> {
  try { return (await api.end({ user: row.wake_user, id: row.ws_subscription_id })).ended === true; } catch { return false; }
}

function jobOf(row: WakeRow): JobSnapshot | null {
  return row.job_id == null ? null : { id: Number(row.job_id), name: row.job_name, status: row.job_status, started_at: row.started_at, finished_at: row.finished_at, finished_us: row.finished_us };
}

async function deliver(engine: BrainEngine, api: WakeshiftApi, row: WakeRow, report: DrainReport): Promise<void> {
  const claimed = await claim(engine, row.id);
  if (!claimed) return;
  const { lease } = claimed;
  const attempts = claimed.attempts + 1;
  try {
    if (!(await principalLive(engine, row))) {
      await endAtWakeshift(api, row);
      if (await settle(engine, row.id, lease, 'ended', { error: 'principal_revoked' })) report.ended++;
      return;
    }
    const job = jobOf(row);
    const marker = jobMarker(job);
    const { payload, text } = jobWake(Number(row.target), job);
    let sent;
    try {
      sent = await api.emit({
        name: row.event, arguments: { job: Number(row.target) }, payload, text,
        id: wakeEmitId(row.event, row.target, marker, row.id, createHash('sha256').update(`${row.wake_user}:${row.created_us}`).digest('hex').slice(0, 12)),
        to: [{ user: row.wake_user, subscription: row.ws_subscription_id }],
      });
    } catch (e) {
      const err = e instanceof WakeshiftError ? e : new WakeshiftError(0, 'network', String(e));
      const retryable = err.status === 0 || err.status === 429 || err.status >= 500;
      if (!retryable || attempts >= WAKE_MAX_ATTEMPTS) {
        await endAtWakeshift(api, row);
        if (await settle(engine, row.id, lease, 'dead', { attempts, error: err.code })) report.dead++;
        return;
      }
      if (await settle(engine, row.id, lease, 'open', { attempts, delayS: retryDelayS(attempts, err), error: err.code })) report.retried++;
      return;
    }
    if (sent.matched > 0 || sent.duplicate) {
      if (await settle(engine, row.id, lease, 'delivered', { marker, error: null })) report.delivered++;
    } else if (await settle(engine, row.id, lease, 'ended', { marker, error: 'unmatched' })) {
      report.ended++;
    }
  } catch (e) {
    const dead = attempts >= WAKE_MAX_ATTEMPTS;
    if (dead) await endAtWakeshift(api, row);
    const settled = await settle(engine, row.id, lease, dead ? 'dead' : 'open', { attempts, ...(dead ? {} : { delayS: retryDelayS(attempts) }), error: 'drain_error' }).catch(() => false);
    if (settled && dead) report.dead++;
    throw e;
  }
}

/**
 * One reconciliation pass: ends expired watches, then delivers up to 20 due ones (only `ids` when given). Returns
 * `skipped: 'off'` without a query when reporting back is off or keyless. `api` is a test seam.
 */
export async function drainWakes(engine: BrainEngine, opts: { ids?: number[]; api?: WakeshiftApi } = {}): Promise<DrainReport> {
  const report: DrainReport = { delivered: 0, retried: 0, dead: 0, ended: 0 };
  const api = opts.api ?? wakeshiftRuntime()?.api;
  if (!api) return { ...report, skipped: 'off' };
  if (await liveAccessMembers(engine) > 0) return { ...report, skipped: 'shared' };
  const expired = await engine.executeRaw<{ id: number; wake_user: string; ws_subscription_id: string }>(
    `UPDATE wake_subscriptions SET state = 'ended', last_error = 'expired', updated_at = now()
      WHERE state = 'open' AND expires_at < now() RETURNING id, wake_user, ws_subscription_id`);
  report.ended += expired.length;
  const rows = await engine.executeRaw<WakeRow>(CANDIDATES_SQL(opts.ids !== undefined), opts.ids !== undefined ? [opts.ids] : []);
  let failure: unknown = null;
  for (const row of rows) {
    try { await deliver(engine, api, row, report); } catch (e) { failure ??= e; }
  }
  if (failure !== null) throw failure;
  return report;
}

/** Passes until one has nothing left to settle (at most 10): the final pass of a process about to exit (`gbrain jobs work`). */
export async function drainWakesUntilIdle(engine: BrainEngine): Promise<DrainReport> {
  const total: DrainReport = { delivered: 0, retried: 0, dead: 0, ended: 0 };
  let failure: unknown = null;
  for (let i = 0; i < 10; i++) {
    let r: DrainReport;
    try { r = await drainWakes(engine); } catch (e) { failure ??= e; continue; }
    if (r.skipped) return { ...total, skipped: r.skipped };
    total.delivered += r.delivered; total.retried += r.retried; total.dead += r.dead; total.ended += r.ended;
    if (r.delivered + r.dead + r.ended === 0) break;
  }
  if (failure !== null) throw failure;
  return total;
}

/** The 5 s drainer timer for a long-lived process (serve, worker). Never throws, never keeps the process alive; logs each distinct failure once to stderr. */
export function startWakeDrain(engine: BrainEngine, opts: { intervalMs?: number; onError?: (e: unknown) => void } = {}): { stop(): void } {
  const logged = new Set<string>();
  const onError = opts.onError ?? ((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    if (logged.has(message) || logged.size >= 20) return;
    logged.add(message);
    console.error(`[wakeshift] wake drain failed: ${message}`);
  });
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    drainWakes(engine).catch(onError).finally(() => { running = false; });
  }, opts.intervalMs ?? WAKE_DRAIN_TICK_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
