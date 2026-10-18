/**
 * #6317 (reporter ask 2 on #6278): which connection the persistence consumer's
 * own statements take.
 *
 * The production wedge reproduced with one process: through a transaction-mode
 * pooler (Supavisor :6543) the consumer's `expired_claims` round-trip never
 * completed (backend `active` in `ClientRead` for minutes), while the same
 * drain on the session-mode URL ran clean. So when the engine has a direct
 * route (the dual pool: `GBRAIN_DIRECT_DATABASE_URL`, or the Supabase
 * auto-derived direct URL; postgres-engine.ts `executeRawDirect` and
 * `transactionDirect` take it when `connectionManager.isDualPoolActive()`),
 * the consumer's tick statements (the idle probe, switch read, recovery and
 * expired-claim scans, capacity marking, claims and releases) run on it,
 * beside the claim renewals and the heartbeat that already do. The
 * publication transactions and the preparers keep their routes; this module
 * is connection selection only (the bounded client-side settle of a hung
 * round-trip lives in postgres-engine.ts).
 *
 * When only a transaction-mode pooler URL exists (`prepare: false` is the
 * detectable sign, db.ts `resolvePrepare`: port 6543 or `?prepare=false`),
 * the consumer logs one loud line at start and `status()` reports
 * `connection.pooler_mode: 'transaction'`, so an operator sees the exposure in
 * `gbrain sources writer status --json` before the first stall.
 *
 * `GBRAIN_CONSUMER_DIRECT_LANE=0` keeps the tick statements on the ordinary
 * pool even with a direct route (the claims, renewals and heartbeat still take
 * it): the escape hatch when the direct pool is too small for the scans, and
 * what the phase-liveness tests set to exercise the claim's BEGIN as the first
 * direct statement.
 */
import type { BrainEngine } from '../engine.ts';
import { registerEngineView, viewedEngine } from './switches.ts';

export interface ConsumerConnectionRoute {
  /** Where the consumer's statements run: the direct/session route, or the ordinary pool. */
  lane: 'direct' | 'pool';
  /** What the ordinary pool's URL is: a transaction-mode pooler (heuristic: `prepare: false`), a session-mode or direct server, or not Postgres. */
  pooler_mode: 'transaction' | 'session_or_direct' | 'not_postgres' | 'unknown';
  direct_host?: string;
}

type RoutedEngine = BrainEngine & {
  connectionManager?: { isDualPoolActive(): boolean; describeMode(): { direct_host?: string } } | null;
  sql?: { options?: { prepare?: boolean } };
};

/** The route this engine gives the consumer right now (the dual pool initializes lazily and can fall back, so this is read per call). */
export function consumerConnectionRoute(engine: BrainEngine): ConsumerConnectionRoute {
  if (engine.kind !== 'postgres') return { lane: 'pool', pooler_mode: 'not_postgres' };
  const routed = engine as RoutedEngine;
  let direct = false, directHost: string | undefined, prepare: boolean | undefined;
  try { direct = process.env.GBRAIN_CONSUMER_DIRECT_LANE !== '0' && routed.connectionManager?.isDualPoolActive() === true; directHost = direct ? routed.connectionManager?.describeMode().direct_host : undefined; } catch { direct = false; }
  try { prepare = routed.sql?.options?.prepare; } catch { prepare = undefined; }
  return { lane: direct ? 'direct' : 'pool', pooler_mode: prepare === false ? 'transaction' : prepare === undefined ? 'unknown' : 'session_or_direct', ...(directHost ? { direct_host: directHost } : {}) };
}

/**
 * The engine the consumer's own statements run through: `executeRaw` goes to `executeRawDirect` while the direct route is
 * active, every other member reaches the engine unchanged. Non-Postgres engines and engines without a direct route are
 * returned as they are.
 */
export function consumerStatementEngine(engine: BrainEngine): BrainEngine {
  if (engine.kind !== 'postgres' || typeof engine.executeRawDirect !== 'function') return engine;
  return registerEngineView(new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return (sql: string, params?: unknown[], opts?: { signal?: AbortSignal; timeoutMs?: number }) =>
      consumerConnectionRoute(target).lane === 'direct' && opts?.timeoutMs === undefined ? target.executeRawDirect(sql, params, opts) : target.executeRaw(sql, params, opts);
    const member = Reflect.get(target, key, target);
    return typeof member === 'function' ? member.bind(target) : member;
  } }), viewedEngine(engine));
}

/** The one loud line a consumer prints when it starts on a transaction-mode pooler with no direct route. */
export function poolerExposureLine(route: ConsumerConnectionRoute): string | null {
  if (route.lane === 'direct' || route.pooler_mode !== 'transaction') return null;
  return '[persistence] phase=start reason=transaction_pooler message="the persistence consumer runs its statements through a transaction-mode pooler '
    + '(prepare=false, port 6543) with no direct route; a round-trip the pooler never completes cannot be ended by any server timeout"; '
    + 'fix: set GBRAIN_DIRECT_DATABASE_URL to the session-mode (port 5432) or direct URL of the same database and restart; verify: gbrain sources writer status --json (connection.lane: direct); '
    + 'docs: docs/ENGINES.md#persistence-consumer-log';
}
