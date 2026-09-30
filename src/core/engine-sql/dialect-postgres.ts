/**
 * Postgres dialect adapter for the engine-sql executor (refactor wave 1, W1 / A4).
 *
 * Wraps one postgres.js handle: the engine's pool (`this.sql`) or a
 * transaction / savepoint handle. `PostgresEngine#engineSql` builds a fresh
 * adapter over `this.sql` on every access (EO1).
 *
 * Driver options (EO2 / EO6 / EO9):
 *   query / run   statements converted from master's tagged templates go
 *                 through `runUnsafe(conn, sql, params, { signal?, prepare:
 *                 true, simple: false })`. postgres.js ANDs the per-call
 *                 `prepare` with the connection option, so direct Postgres keeps
 *                 named prepared statements and PgBouncer (connection
 *                 `prepare: false`) stays unprepared; `simple: false` keeps a
 *                 zero-parameter statement on the extended protocol, exactly
 *                 like a tagged template. No `checkoutGauge` accounting, like
 *                 tagged calls.
 *   executeRaw    master's `engine.executeRaw` path: the `raw` gauge around
 *                 `runUnsafe` with default options.
 *   unsafe        master's direct `conn.unsafe(sql, params)` (default options,
 *                 no gauge).
 */

import type postgres from '#postgres';
import type { CheckoutGauge } from '../pool-gauge.ts';
import { renderFragment, type SqlFragment } from './fragment.ts';
import {
  isJsonbParam,
  type DialectCapabilities,
  type ExecResult,
  type QueryOpts,
  type Row,
  type SqlExecutor,
} from './executor.ts';

type PgConn = ReturnType<typeof postgres>;

export interface RunUnsafeOpts {
  signal?: AbortSignal;
  prepare?: boolean;
  simple?: boolean;
}

/** `PostgresEngine#runUnsafe`, bound by the engine (it owns cancellation + reservation). */
export type RunUnsafe = <T>(conn: PgConn, sql: string, params?: unknown[], opts?: RunUnsafeOpts) => Promise<T[]>;

export interface PostgresExecutorDeps {
  readonly runUnsafe: RunUnsafe;
  readonly gauge: Pick<CheckoutGauge, 'acquire' | 'release'>;
}

export const POSTGRES_CAPABILITIES: DialectCapabilities = {
  maxBindParamsPerStatement: Number.POSITIVE_INFINITY,
  transactionAdvisoryLocks: true,
  probesEmbeddingCast: true,
};

function bind(conn: PgConn, params: readonly unknown[] | undefined): unknown[] {
  if (!params) return [];
  return params.map((p) => (isJsonbParam(p) ? conn.json(p.value as postgres.JSONValue) : p));
}

function envelope<R>(result: unknown): ExecResult<R> {
  return { rows: result as R[], affectedRows: (result as { count?: number }).count ?? 0 };
}

export function postgresExecutor(conn: PgConn, deps: PostgresExecutorDeps): SqlExecutor {
  const query = async <R = Row>(sql: string, params?: readonly unknown[], opts?: QueryOpts): Promise<ExecResult<R>> =>
    envelope<R>(await deps.runUnsafe<R>(conn, sql, bind(conn, params), { signal: opts?.signal, prepare: true, simple: false }));
  return {
    dialect: 'postgres',
    capabilities: POSTGRES_CAPABILITIES,
    query,
    run<R = Row>(fragment: SqlFragment, opts?: QueryOpts) {
      const { text, params } = renderFragment(fragment);
      return query<R>(text, params, opts);
    },
    async executeRaw<R = Row>(sql: string, params?: unknown[], opts?: QueryOpts): Promise<R[]> {
      deps.gauge.acquire('raw');
      try {
        return await deps.runUnsafe<R>(conn, sql, params, opts);
      } finally {
        deps.gauge.release('raw');
      }
    },
    async unsafe<R = Row>(sql: string, params: readonly unknown[]) {
      return envelope<R>(await conn.unsafe(sql, bind(conn, params) as never[]));
    },
    transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return conn.begin((tx) => fn(postgresExecutor(tx as unknown as PgConn, deps))) as Promise<T>;
    },
  };
}
