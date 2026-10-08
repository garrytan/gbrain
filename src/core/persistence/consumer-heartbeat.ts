/**
 * #6317 (B1a, B3): the per-process heartbeat of a full persistence consumer and
 * the probe a resident process runs before starting its own.
 *
 * One row per process in `persistence_consumers` (migration v222), keyed by
 * `(host_id, pid, nonce)`: the nonce is random per process and `pid_ns` is the
 * pid-namespace inode, so a reused pid after a container restart, or the same
 * pid in two namespaces sharing one `GBRAIN_HOME`, is never mistaken for the
 * same consumer. `renewed_at` is the liveness signal: live within
 * `CONSUMER_LIVE_MS`, lapsed at `CONSUMER_LAPSED_MS`, and each renewal deletes
 * this host's rows lapsed longer than `CONSUMER_PURGE_MS` in the same statement
 * (a data-modifying CTE; idempotent, no lock). The row also carries the owner's
 * own wedge report (`restart_required`, the age of its oldest abandoned root
 * barrier) and its identity file paths, so a waiter and doctor judge the owner
 * from the database alone, never from a socket or its filesystem.
 *
 * The heartbeat is single-flight on its own timer (default every 10 s, each
 * renewal under its own deadline), independent of claim renewal: an idle
 * `serve` holds no claim and still has to prove it is alive. Renewals run on
 * the engine's direct lane (`executeRawDirect`, as the claim lease does). On
 * Postgres that lane leaves the ordinary pool only when the dual pool is
 * active (postgres-engine.ts `executeRawDirect`: `connectionManager.ddl()` is
 * taken only when `isDualPoolActive()`), so with a single URL the heartbeat
 * shares the ordinary pool and a starved pool stops it. That is acceptable: the
 * row is a liveness signal, not a progress signal, and a starved owner losing
 * its suppression is the wanted outcome. A failed renewal is logged once per
 * failure streak and never stops the consumer. PGLite admits one process, so
 * the probe answers "no owner" and the heartbeat writes nothing there.
 */
import { randomBytes } from 'node:crypto';
import { readlinkSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import { VERSION } from '../../version.ts';
import { localHostIdentity } from './identity.ts';
import type { SqlEngine } from './model.ts';

/** Kinds whose process stays resident: they defer to the first live full consumer of their host (`serve` always starts full). */
export const RESIDENT_CONSUMER_KINDS: readonly string[] = ['serve', 'sync', 'jobs', 'autopilot', 'mcp'];
/** A row renewed within this window is live. */
export const CONSUMER_LIVE_MS = 30_000;
/** A row not renewed for this long is lapsed: its process is gone or starved; a waiter promotes itself. */
export const CONSUMER_LAPSED_MS = 60_000;
/** A row lapsed this long is deleted by the next renewal of any consumer on the host. */
export const CONSUMER_PURGE_MS = 90_000;
/** Renewal cadence of a full consumer's heartbeat. */
export const CONSUMER_RENEWAL_MS = 10_000;
/** How long one renewal or probe may take before it is dropped (the consumer's phase deadline). */
export const CONSUMER_DEADLINE_MS = 5_000;

export type ConsumerRowMode = 'probing' | 'full' | 'waiter_only' | 'promoted';
/** Process identity: `{ pid, nonce, pid_ns }`; `kind` names the gbrain command. */
export interface ConsumerProcessIdentity { pid: number; nonce: string; pid_ns: string | null }
export interface ConsumerPool { checked_out: number; max: number; waiters: number }
export interface ConsumerRow {
  host_id: string;
  pid: number;
  nonce: string;
  pid_ns: string | null;
  kind: string;
  mode: ConsumerRowMode;
  started_at: string;
  renewed_at: string;
  restart_required: boolean;
  root_barrier_age_ms: number | null;
  pool: ConsumerPool | null;
  host_json_path: string;
  persistence_home: string;
  minted_under: Record<string, unknown> | null;
  version: string;
}
/** A row as `listHostConsumers` returns it: the row plus its liveness, read on the database clock. */
export interface ListedConsumer extends ConsumerRow {
  /** Milliseconds since the last renewal. */
  renewed_age_ms: number;
  /** Milliseconds since the process started its consumer. */
  age_ms: number;
  liveness: 'live' | 'stale' | 'lapsed';
  /** Whether this row belongs to the calling process. */
  self: boolean;
}

let identity: ConsumerProcessIdentity | undefined;
/** This process's identity for stamps and rows: pid, a random per-process nonce, and the pid namespace where readable. */
export function consumerIdentity(): ConsumerProcessIdentity {
  if (identity) return identity;
  let pidNs: string | null = null;
  try { pidNs = readlinkSync('/proc/self/ns/pid'); } catch { pidNs = null; }
  identity = { pid: process.pid, nonce: randomBytes(8).toString('hex'), pid_ns: pidNs };
  return identity;
}
/** Test seam: a fresh identity, so one test process can play several consumers. */
export function resetConsumerIdentityForTest(next?: Partial<ConsumerProcessIdentity>): ConsumerProcessIdentity {
  identity = undefined;
  identity = { ...consumerIdentity(), ...next };
  return identity;
}
/** Whether `owner` (a claim stamp's or a row's identity) is this process: the pid and, when both sides carry one, the nonce. */
export function sameProcess(owner: { pid?: number | null; nonce?: string | null } | null | undefined, self: ConsumerProcessIdentity = consumerIdentity()): boolean {
  if (!owner || owner.pid !== self.pid) return false;
  return owner.nonce == null || owner.nonce === self.nonce;
}

const ROW_COLUMNS = `host_id::text AS host_id,pid,nonce,pid_ns,kind,mode,started_at::text AS started_at,renewed_at::text AS renewed_at,restart_required,root_barrier_age_ms,pool,
  host_json_path,persistence_home,minted_under,version,(EXTRACT(EPOCH FROM (now()-renewed_at))*1000)::bigint::text AS renewed_age_ms,
  (EXTRACT(EPOCH FROM (now()-started_at))*1000)::bigint::text AS age_ms`;
type RawRow = Omit<ConsumerRow, 'pool' | 'minted_under'> & { pool: unknown; minted_under: unknown; renewed_age_ms: string; age_ms: string };

function parseJson(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === 'string') { try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; } }
  return typeof value === 'object' ? value as Record<string, unknown> : null;
}
function listed(row: RawRow, self: ConsumerProcessIdentity): ListedConsumer {
  const renewedAge = Number(row.renewed_age_ms);
  return { ...row, pool: parseJson(row.pool) as ConsumerPool | null, minted_under: parseJson(row.minted_under),
    renewed_age_ms: renewedAge, age_ms: Number(row.age_ms),
    liveness: renewedAge < CONSUMER_LIVE_MS ? 'live' : renewedAge < CONSUMER_LAPSED_MS ? 'stale' : 'lapsed',
    self: row.pid === self.pid && row.nonce === self.nonce };
}

/** Every consumer row of `hostId`, oldest first, with liveness on the database clock. Empty on PGLite. */
export async function listHostConsumers(engine: SqlEngine & Partial<Pick<BrainEngine, 'kind'>>, hostId: string, opts: { signal?: AbortSignal } = {}): Promise<ListedConsumer[]> {
  if (engine.kind === 'pglite') return [];
  const rows = await engine.executeRaw<RawRow>(`SELECT ${ROW_COLUMNS} FROM persistence_consumers WHERE host_id=$1::uuid ORDER BY started_at,pid`, [hostId], { signal: opts.signal });
  const self = consumerIdentity();
  return rows.map(row => listed(row, self));
}

/** A live owner's wedge report: `restart_required`, or a root barrier older than the preparation ceiling (the owner stops suppressing). */
export function consumerWedged(row: Pick<ConsumerRow, 'restart_required' | 'root_barrier_age_ms'>, ceilingMs: number): boolean {
  return row.restart_required || (row.root_barrier_age_ms !== null && row.root_barrier_age_ms >= ceilingMs);
}

/**
 * The first live, full, resident-kind consumer of `hostId` that is not `self`
 * and is not wedged (B1a), or null. Liveness is judged on the database clock
 * (renewed within `CONSUMER_LIVE_MS`), so two hosts' clocks never enter it.
 * PGLite admits one process: always null there. A read the database cannot
 * answer rejects; the caller decides whether that means "no owner".
 */
export async function probeLiveFullConsumer(engine: SqlEngine & Partial<Pick<BrainEngine, 'kind'>>, hostId: string, self: ConsumerProcessIdentity = consumerIdentity(),
  opts: { signal?: AbortSignal; ceilingMs?: number } = {}): Promise<ListedConsumer | null> {
  if (engine.kind === 'pglite') return null;
  const rows = await engine.executeRaw<RawRow>(`SELECT ${ROW_COLUMNS} FROM persistence_consumers
    WHERE host_id=$1::uuid AND mode IN ('full','promoted') AND kind=ANY($2::text[]) AND NOT (pid=$3::integer AND nonce=$4)
      AND renewed_at > now() - ($5::integer * interval '1 millisecond') AND NOT restart_required
    ORDER BY started_at,pid LIMIT 8`, [hostId, [...RESIDENT_CONSUMER_KINDS], self.pid, self.nonce, CONSUMER_LIVE_MS], { signal: opts.signal });
  const ceiling = opts.ceilingMs ?? 600_000;
  const live = rows.map(row => listed(row, self)).find(row => !consumerWedged(row, ceiling));
  return live ?? null;
}

export interface ConsumerHeartbeatOpts {
  kind: string;
  mode: ConsumerRowMode | (() => ConsumerRowMode);
  /** The owner's own wedge report and pool numbers, read at each renewal. */
  report: () => { restart_required: boolean; root_barrier_age_ms: number | null; pool?: ConsumerPool | null };
  everyMs?: number;
  deadlineMs?: number;
  identity?: ConsumerProcessIdentity;
  /** Receives each renewal failure (the default logs once per failure streak). */
  onError?: (error: unknown) => void;
  /** The file paths the row carries (default: this process's host.json and persistence home). */
  paths?: { host_json_path: string; persistence_home: string; minted_under: Record<string, unknown> | null };
}
export interface ConsumerHeartbeat {
  /** Renews now (single-flight: a renewal already in flight is awaited instead). Never rejects. */
  renew(): Promise<void>;
  /** The renewal failures so far, for status. */
  readonly failures: number;
  /** Stops renewing, awaits the in-flight renewal, then deletes this process's row (bounded). */
  stop(): Promise<void>;
}

type DirectEngine = SqlEngine & Partial<Pick<BrainEngine, 'kind' | 'executeRawDirect'>>;
const RENEW_SQL = `WITH purged AS (
    DELETE FROM persistence_consumers WHERE host_id=$1::uuid AND renewed_at < now() - ($14::integer * interval '1 millisecond') AND NOT (pid=$2::integer AND nonce=$3))
  INSERT INTO persistence_consumers(host_id,pid,nonce,pid_ns,kind,mode,restart_required,root_barrier_age_ms,pool,host_json_path,persistence_home,minted_under,version)
  VALUES($1::uuid,$2::integer,$3,$4,$5,$6,$7::boolean,$8::integer,$9::text::jsonb,$10,$11,$12::text::jsonb,$13)
  ON CONFLICT (host_id,pid,nonce) DO UPDATE SET renewed_at=now(),mode=EXCLUDED.mode,restart_required=EXCLUDED.restart_required,
    root_barrier_age_ms=EXCLUDED.root_barrier_age_ms,pool=EXCLUDED.pool,version=EXCLUDED.version`;

/**
 * Starts this process's heartbeat row for `hostId` and renews it every
 * `everyMs` (default 10 s). The first renewal runs at once. Each renewal is
 * bounded by `deadlineMs`; an overrun is cancelled through its signal and
 * counted as a failure. Inert on PGLite (`stop()` resolves at once).
 */
export function startConsumerHeartbeat(engine: DirectEngine, hostId: string, opts: ConsumerHeartbeatOpts): ConsumerHeartbeat {
  if (engine.kind === 'pglite') return { renew: async () => {}, get failures() { return 0; }, stop: async () => {} };
  const self = opts.identity ?? consumerIdentity();
  const paths = opts.paths ?? (() => { const id = localHostIdentity(); return { host_json_path: id.path, persistence_home: id.persistence_home, minted_under: id.minted_under }; })();
  const execute = (sql: string, params: unknown[], signal: AbortSignal) =>
    engine.executeRawDirect ? engine.executeRawDirect(sql, params, { signal }) : engine.executeRaw(sql, params, { signal });
  const everyMs = opts.everyMs ?? CONSUMER_RENEWAL_MS;
  const deadlineMs = opts.deadlineMs ?? CONSUMER_DEADLINE_MS;
  let stopped = false;
  let failures = 0;
  let streak = 0;
  let inFlight: Promise<void> | undefined;
  const report = (error: unknown) => {
    failures++;
    if (opts.onError) { opts.onError(error); return; }
    if (streak++ > 0) return;
    const message = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 200) : String(error);
    process.stderr.write(`[persistence] phase=consumer_heartbeat reason=renewal_failed message="${message}"; this process keeps consuming; `
      + 'other consumers on this host may stop deferring to it after 60 s; fix: gbrain sources writer status --json; docs: docs/ENGINES.md#persistence-consumer-log\n');
  };
  // The deadline settles the await itself (a round-trip a pooler never completes must not park the heartbeat); a late result is dropped.
  const bounded = <T>(work: Promise<T>, cancel: AbortController, ms: number): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { cancel.abort(new Error(`consumer heartbeat statement exceeded ${ms} ms`)); reject(cancel.signal.reason); }, ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
  const renewOnce = async (): Promise<void> => {
    const cancel = new AbortController();
    try {
      const status = opts.report();
      const mode = typeof opts.mode === 'function' ? opts.mode() : opts.mode;
      await bounded(execute(RENEW_SQL, [hostId, self.pid, self.nonce, self.pid_ns, opts.kind, mode, status.restart_required, status.root_barrier_age_ms,
        status.pool ? JSON.stringify(status.pool) : null, paths.host_json_path, paths.persistence_home,
        paths.minted_under ? JSON.stringify(paths.minted_under) : null, VERSION, CONSUMER_PURGE_MS], cancel.signal), cancel, deadlineMs);
      streak = 0;
    } catch (error) {
      if (!stopped) report(error);
    }
  };
  const renew = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    const attempt = renewOnce().finally(() => { if (inFlight === attempt) inFlight = undefined; });
    inFlight = attempt;
    return attempt;
  };
  const cadence = setInterval(() => { void renew(); }, everyMs);
  cadence.unref?.();
  void renew();
  return {
    renew,
    get failures() { return failures; },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(cadence);
      await inFlight;
      const cancel = new AbortController();
      try { await bounded(execute('DELETE FROM persistence_consumers WHERE host_id=$1::uuid AND pid=$2::integer AND nonce=$3', [hostId, self.pid, self.nonce], cancel.signal), cancel, 1_000); }
      catch { /* the row lapses on its own; the next renewal on this host purges it */ }
    },
  };
}
