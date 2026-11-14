/**
 * Wake delivery by pull reconciliation (plan D7). No outbox and no hook in the
 * job queue or the write path: jobs and write requests reach a terminal state
 * in many places and rows can be removed, so the drainer joins open watches
 * to what they watch and emits once it is settled:
 *   - gbrain.job.finished: `minion_jobs` completed, failed, dead or cancelled
 *     (marker `<finished_us>:<status>`, or `gone`);
 *   - gbrain.write.settled: `persistence_requests` committed with no live
 *     recovery record, failed, conflict or cancelled (marker
 *     `<state>:<settled_us>`, or `gone`);
 *   - gbrain.cron.finished: the first `wake_cron_runs` row for the name after
 *     the watch began (marker `<run id>:<status>`).
 * It runs on a 5 s timer inside `gbrain serve` (stdio and HTTP) and the job
 * worker, once more at the end of `gbrain jobs work`, and inside a watch call
 * whose target already settled.
 *
 * Bounded: at most 20 watches a tick; a lease (conditional UPDATE) so two
 * hosts never emit one row; 5 attempts backing off 30 s, 2 m, 8 m, 30 m (a 429
 * waits its Retry-After within the same cap); any other 4xx is final. A dead,
 * revoked or expired watch is ended at Wakeshift once, so the conversation is
 * told. On a brain with live access members a watch whose principal has not
 * accepted the operator's current terms ends with terms_not_accepted instead
 * of emitting (terms.ts). Queued forgets (forget.ts) go out under the same
 * attempt schedule, at most 10 a tick. Off or keyless: the tick returns before
 * touching the database.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { memberIdentityFor } from '../access/caller.ts';
import { WakeshiftError, type WakeshiftApi } from './client.ts';
import { wakeshiftRuntime, type WakeshiftRuntime } from './config.ts';
import { CRON_FINISHED, JOB_FINISHED, WRITE_SETTLED, cronMarker, cronWake, jobMarker, jobWake, wakeEmitId, writeMarker, writeWake, type JobSnapshot, type WriteSnapshot } from './events.ts';
import { operatorTerms, termsAccepted, type OperatorTerms } from './terms.ts';

export const WAKE_RETRY_SCHEDULE_S = [30, 120, 480, 1800] as const;
export const WAKE_MAX_ATTEMPTS = 5;
export const WAKE_DRAIN_BATCH = 20;
export const WAKE_DRAIN_TICK_MS = 5_000;
export const FORGET_DRAIN_BATCH = 10;
const LEASE_S = 60;
const TERMINAL = `('completed', 'failed', 'dead', 'cancelled')`;
const WRITE_TERMINAL = `('failed', 'conflict', 'cancelled')`;

export interface WakeRow {
  id: number;
  event: string;
  target: string;
  target_ref: string | null;
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

export interface DrainReport { delivered: number; retried: number; dead: number; ended: number; forgotten?: number; skipped?: 'off' }

const US = (col: string) => `(floor(extract(epoch FROM ${col}) * 1000000))::bigint::text`;

/**
 * Open, due, unleased watches whose target settled, one row per watch across the three event families (each LEFT JOIN
 * matches only its own event), at most 20.
 */
const CANDIDATES_SQL = (byId: boolean) => `
SELECT w.id, w.event, w.target, w.target_ref, w.principal_kind, w.principal_id, w.member_id, w.wake_user, w.ws_subscription_id, w.attempts,
       ${US('w.created_at')} AS created_us,
       j.id AS job_id, j.name AS job_name, j.status AS job_status, j.started_at, j.finished_at, ${US('j.finished_at')} AS finished_us,
       r.id::text AS req_id, r.state AS req_state, r.operation AS req_operation, r.source_id AS req_source_id, r.created_at AS req_created_at,
       COALESCE(r.completed_at, r.updated_at) AS req_settled_at, ${US('COALESCE(r.completed_at, r.updated_at)')} AS req_settled_us,
       c.id AS run_id, c.status AS run_status, c.finished_at AS run_finished_at
  FROM wake_subscriptions w
  LEFT JOIN minion_jobs j ON w.event = '${JOB_FINISHED}' AND j.id = CASE WHEN w.event = '${JOB_FINISHED}' AND w.target ~ '^[0-9]{1,18}$' THEN w.target::bigint END
  LEFT JOIN persistence_requests r ON w.event = '${WRITE_SETTLED}'
       AND r.id = CASE WHEN w.event = '${WRITE_SETTLED}' AND w.target_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN w.target_ref::uuid END
  LEFT JOIN LATERAL (SELECT cr.id, cr.status, cr.finished_at FROM wake_cron_runs cr
       WHERE w.event = '${CRON_FINISHED}' AND cr.name = w.target AND cr.finished_at >= w.created_at ORDER BY cr.finished_at, cr.id LIMIT 1) c ON true
 WHERE w.state = 'open' AND w.next_attempt_at <= now() AND (w.lease_until IS NULL OR w.lease_until < now())
   AND CASE w.event
     WHEN '${JOB_FINISHED}' THEN (j.id IS NULL OR j.status IN ${TERMINAL})
     WHEN '${WRITE_SETTLED}' THEN (r.id IS NULL OR r.state IN ${WRITE_TERMINAL} OR (r.state = 'committed' AND r.recovery IS NULL))
     WHEN '${CRON_FINISHED}' THEN c.id IS NOT NULL
     ELSE false END
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

/** Live access members: on a brain with any, every watch needs its principal's acceptance of the operator's terms (terms.ts). */
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

function writeOf(row: WakeRow): WriteSnapshot | null {
  return row.req_id == null ? null : { state: row.req_state, operation: row.req_operation, source_id: row.req_source_id, created_at: row.req_created_at, settled_at: row.req_settled_at, settled_us: row.req_settled_us };
}

/** The emit for a settled watch: its marker, arguments (the manifest's), payload and line. */
function wakeFor(row: WakeRow): { marker: string; args: Record<string, unknown>; payload: Record<string, unknown>; text: string } {
  if (row.event === WRITE_SETTLED) {
    const req = writeOf(row);
    return { marker: writeMarker(req), args: { request_id: row.target }, ...writeWake(row.target, req) };
  }
  if (row.event === CRON_FINISHED) {
    const run = { id: row.run_id!, status: row.run_status!, finished_at: row.run_finished_at };
    return { marker: cronMarker(run), args: { name: row.target }, ...cronWake(row.target, run) };
  }
  const job = jobOf(row);
  return { marker: jobMarker(job), args: { job: Number(row.target) }, ...jobWake(Number(row.target), job) };
}

/** Queue a Wakeshift forget for a revoked credential's own user (a member's user is forgotten when the member is removed, forget.ts). */
async function queueForget(engine: BrainEngine, row: WakeRow): Promise<void> {
  if (row.member_id || row.principal_kind === 'local_stdio') return;
  await engine.executeRaw(`INSERT INTO wake_forgets (wake_user) VALUES ($1) ON CONFLICT (wake_user) WHERE state = 'pending' DO NOTHING`, [row.wake_user]);
}

async function deliver(engine: BrainEngine, api: WakeshiftApi, row: WakeRow, report: DrainReport, terms: { shared: boolean; current: OperatorTerms | null }): Promise<void> {
  const claimed = await claim(engine, row.id);
  if (!claimed) return;
  const { lease } = claimed;
  const attempts = claimed.attempts + 1;
  try {
    if (!(await principalLive(engine, row))) {
      await endAtWakeshift(api, row);
      await queueForget(engine, row);
      if (await settle(engine, row.id, lease, 'ended', { error: 'principal_revoked' })) report.ended++;
      return;
    }
    if (terms.shared && !(await termsAccepted(engine, row, terms.current))) {
      await endAtWakeshift(api, row);
      if (await settle(engine, row.id, lease, 'ended', { error: 'terms_not_accepted' })) report.ended++;
      return;
    }
    const { marker, args, payload, text } = wakeFor(row);
    let sent;
    try {
      sent = await api.emit({
        name: row.event, arguments: args, payload, text,
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

/** Send up to 10 due queued forgets (forget.ts) under a lease; `forgotten: false` (nothing held) also completes one. */
async function drainForgets(engine: BrainEngine, api: WakeshiftApi, report: DrainReport): Promise<void> {
  const due = await engine.executeRaw<{ id: number; wake_user: string; attempts: number; lease: string }>(
    `UPDATE wake_forgets SET lease_until = now() + interval '${LEASE_S} seconds', updated_at = now()
      WHERE id IN (SELECT id FROM wake_forgets WHERE state = 'pending' AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
                    ORDER BY next_attempt_at, id LIMIT ${FORGET_DRAIN_BATCH})
        AND state = 'pending' AND (lease_until IS NULL OR lease_until < now())
      RETURNING id, wake_user, attempts, ${US('lease_until')} AS lease`);
  const done = (id: number, lease: string, state: 'pending' | 'done' | 'dead', attempts: number, error: string | null, delayS?: number) => engine.executeRaw(
    `UPDATE wake_forgets SET state = $2, attempts = $3, last_error = $4, lease_until = NULL, updated_at = now(),
        next_attempt_at = CASE WHEN $5::int IS NULL THEN next_attempt_at ELSE now() + make_interval(secs => $5::int) END
      WHERE id = $1 AND state = 'pending' AND ${US('lease_until')} = $6`, [id, state, attempts, error, delayS ?? null, lease]);
  for (const row of due) {
    const attempts = Number(row.attempts) + 1;
    try {
      await api.forget({ user: row.wake_user });
      await done(row.id, row.lease, 'done', attempts, null);
      report.forgotten = (report.forgotten ?? 0) + 1;
    } catch (e) {
      const err = e instanceof WakeshiftError ? e : new WakeshiftError(0, 'network', String(e));
      const retryable = err.status === 0 || err.status === 429 || err.status >= 500;
      if (!retryable || attempts >= WAKE_MAX_ATTEMPTS) await done(row.id, row.lease, 'dead', attempts, err.code);
      else await done(row.id, row.lease, 'pending', attempts, err.code, retryDelayS(attempts, err));
    }
  }
}

/**
 * One reconciliation pass: ends expired watches, sends queued forgets, then delivers up to 20 due watches (only `ids`
 * when given). Returns `skipped: 'off'` without a query when reporting back is off or keyless. `runtime` is the
 * caller's (the watch tools) or a test seam.
 */
export async function drainWakes(engine: BrainEngine, opts: { ids?: number[]; runtime?: WakeshiftRuntime } = {}): Promise<DrainReport> {
  const report: DrainReport = { delivered: 0, retried: 0, dead: 0, ended: 0 };
  const runtime = opts.runtime ?? wakeshiftRuntime();
  if (!runtime) return { ...report, skipped: 'off' };
  const { api } = runtime;
  const terms = { shared: await liveAccessMembers(engine) > 0, current: operatorTerms(runtime.file) };
  const expired = await engine.executeRaw<{ id: number; wake_user: string; ws_subscription_id: string }>(
    `UPDATE wake_subscriptions SET state = 'ended', last_error = 'expired', updated_at = now()
      WHERE state = 'open' AND expires_at < now() RETURNING id, wake_user, ws_subscription_id`);
  report.ended += expired.length;
  if (opts.ids === undefined) await drainForgets(engine, api, report);
  const rows = await engine.executeRaw<WakeRow>(CANDIDATES_SQL(opts.ids !== undefined), opts.ids !== undefined ? [opts.ids] : []);
  let failure: unknown = null;
  for (const row of rows) {
    try { await deliver(engine, api, row, report, terms); } catch (e) { failure ??= e; }
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
    if (r.forgotten) total.forgotten = (total.forgotten ?? 0) + r.forgotten;
    if (r.delivered + r.dead + r.ended + (r.forgotten ?? 0) === 0) break;
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
