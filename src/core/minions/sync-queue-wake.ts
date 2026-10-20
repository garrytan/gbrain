/**
 * GBRA-133 PR 2a.4: wake an idle `gbrain jobs work` claim loop as soon as a `sync` job is queued, instead of after the
 * worker's 5 s idle poll.
 *
 * Two modes, chosen once at worker boot:
 * - `listen`: LISTEN on the `minion_jobs` channel the schema's `notify_minion_job_change` trigger already publishes to,
 *   and wake on a `sync` job turning `waiting` in this worker's queue. Only on a connection detected as a direct
 *   session: the engine's direct route (dual pool), or a pool URL that is not a transaction pooler (`prepare` is not
 *   off; db.ts `resolvePrepare`, read through consumer-lane.ts). Behind a transaction pooler a LISTEN outlives the
 *   transaction that ran it, so its notifications reach whichever client holds that server connection next, or nobody.
 *   A probe NOTIFY right after LISTEN must arrive within LISTEN_PROBE_MS, otherwise the worker polls instead.
 * - `poll`: while the claim loop is idle-waiting, one indexed `minion_jobs` read every `GBRAIN_WORKER_SYNC_WAKE_POLL_MS`
 *   (default 1 s, 250 ms to 5 s); no query while a job runs.
 * `off` on PGLite (`jobs work` drains in the foreground there) and with `GBRAIN_WORKER_SYNC_WAKE=0`.
 *
 * The claim loop's own poll stays the backstop in every mode: a lost notification costs at most one poll interval.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { IdleWaiter } from './idle-wait.ts';
import { consumerConnectionRoute } from '../persistence/consumer-lane.ts';

export const SYNC_WAKE_CHANNEL = 'minion_jobs';
export const SYNC_WAKE_POLL_MS_DEFAULT = 1_000;
export const LISTEN_PROBE_MS = 3_000;

export type SyncQueueWakeMode = 'listen' | 'poll' | 'off';
export interface SyncQueueWakeChoice {
  mode: SyncQueueWakeMode;
  reason: 'disabled' | 'not_postgres' | 'direct_route' | 'direct_session' | 'transaction_pooler' | 'pooler_mode_unknown' | 'listen_unverified';
}
export interface SyncQueueWake extends SyncQueueWakeChoice { readonly pollMs: number; stop(): Promise<void> }

type ListenSql = { listen(channel: string, fn: (payload: string) => void): Promise<{ unlisten(): Promise<void> }> };
type RoutedEngine = BrainEngine & { connectionManager?: { isDualPoolActive(): boolean; ddl(): Promise<unknown> } | null; sql?: unknown };

/** Which wake this engine gets: LISTEN only on a detected direct session, the short poll otherwise. */
export function chooseSyncQueueWake(engine: BrainEngine, env: Record<string, string | undefined> = process.env): SyncQueueWakeChoice {
  if (env.GBRAIN_WORKER_SYNC_WAKE === '0') return { mode: 'off', reason: 'disabled' };
  if (engine.kind !== 'postgres') return { mode: 'off', reason: 'not_postgres' };
  let direct = false;
  try { direct = (engine as RoutedEngine).connectionManager?.isDualPoolActive() === true; } catch { direct = false; }
  if (direct) return { mode: 'listen', reason: 'direct_route' };
  const { pooler_mode } = consumerConnectionRoute(engine);
  if (pooler_mode === 'session_or_direct') return { mode: 'listen', reason: 'direct_session' };
  return { mode: 'poll', reason: pooler_mode === 'transaction' ? 'transaction_pooler' : 'pooler_mode_unknown' };
}

export function syncQueueWakePollMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.GBRAIN_WORKER_SYNC_WAKE_POLL_MS;
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) ? Math.min(5_000, Math.max(250, Math.round(value))) : SYNC_WAKE_POLL_MS_DEFAULT;
}

/** A queued-sync notification for this worker's queue. */
export function isSyncWakePayload(payload: string, queue: string): boolean {
  try {
    const row = JSON.parse(payload) as { name?: unknown; status?: unknown; queue?: unknown };
    return row.name === 'sync' && row.status === 'waiting' && row.queue === queue;
  } catch { return false; }
}

async function listenSql(engine: BrainEngine, reason: SyncQueueWakeChoice['reason']): Promise<ListenSql> {
  const routed = engine as RoutedEngine;
  if (reason === 'direct_route' && routed.connectionManager) return await routed.connectionManager.ddl() as ListenSql;
  return routed.sql as ListenSql;
}

/** Start the wake for one worker's idle waiter and log one line naming the mode. Never throws: a failed or unverified LISTEN polls instead. */
export async function startSyncQueueWake(engine: BrainEngine, waiter: Pick<IdleWaiter, 'wake' | 'idle'>,
  opts: { queue: string; env?: Record<string, string | undefined>; log?: (line: string) => void }): Promise<SyncQueueWake> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const pollMs = syncQueueWakePollMs(env);
  let choice = chooseSyncQueueWake(engine, env);
  let stopped = false;

  if (choice.mode === 'listen') {
    try {
      const sql = await listenSql(engine, choice.reason);
      const probe = `probe:${randomUUID()}`;
      let probed: () => void = () => {};
      const arrived = new Promise<boolean>(resolve => {
        probed = () => resolve(true);
        setTimeout(() => resolve(false), LISTEN_PROBE_MS).unref?.();
      });
      const listener = await sql.listen(SYNC_WAKE_CHANNEL, payload => {
        if (payload === probe) { probed(); return; }
        if (!stopped && isSyncWakePayload(payload, opts.queue)) waiter.wake('sync_queue_notify');
      });
      await engine.executeRaw('SELECT pg_notify($1, $2)', [SYNC_WAKE_CHANNEL, probe]);
      if (await arrived) {
        log(`[gbrain jobs] sync-queue wake: listen (${choice.reason})`);
        return { ...choice, pollMs, stop: async () => { stopped = true; await listener.unlisten().catch(() => {}); } };
      }
      await listener.unlisten().catch(() => {});
    } catch (error) {
      log(`[gbrain jobs] sync-queue wake: LISTEN failed (${error instanceof Error ? error.message : String(error)})`);
    }
    choice = { mode: 'poll', reason: 'listen_unverified' };
  }

  if (choice.mode === 'off') {
    if (choice.reason === 'disabled') log('[gbrain jobs] sync-queue wake: off (GBRAIN_WORKER_SYNC_WAKE=0)');
    return { ...choice, pollMs, stop: async () => { stopped = true; } };
  }

  log(`[gbrain jobs] sync-queue wake: poll every ${pollMs} ms (${choice.reason})`);
  let inflight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (stopped || inflight || !waiter.idle) return;
    inflight = engine.executeRaw<{ one: number }>(
      `SELECT 1 AS one FROM minion_jobs WHERE queue = $1 AND name = 'sync' AND status = 'waiting' LIMIT 1`, [opts.queue])
      .then(rows => { if (!stopped && rows.length > 0) waiter.wake('sync_queue_poll'); }, () => { /* the claim loop's own poll is the backstop */ })
      .finally(() => { inflight = null; });
  }, pollMs);
  timer.unref?.();
  return { ...choice, pollMs, stop: async () => { stopped = true; clearInterval(timer); await inflight; } };
}
