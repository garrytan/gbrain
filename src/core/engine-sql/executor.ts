/**
 * Engine-sql executor contract (refactor wave 1, W1 / A1; docs/architecture/infra-layer.md).
 *
 * One storage domain, one SQL implementation: `src/core/engine-sql/<domain>.ts`
 * takes a `SqlExecutor` and never learns which engine it runs on. Two dialect
 * adapters implement it: `dialect-pglite.ts` (PGLite `db.query`) and
 * `dialect-postgres.ts` (postgres.js via `PostgresEngine#runUnsafe`).
 *
 * Contract (every item is pinned by a test named in docs/TESTING.md#engine-sql):
 *
 * - Lifetime (EO1): an executor wraps ONE connection handle. Engines expose it
 *   through a getter (`engineSql`) that reads `this.sql` / `this.db` on every
 *   access and is never stored, because `transaction()` clones the engine with
 *   `Object.create(this)` and swaps that handle. Domain code receives the
 *   executor per call and never caches it across calls.
 * - Transactions: `transaction(fn)` opens `BEGIN` on a root handle and a
 *   savepoint on a transaction handle (the engines' composable handles), so
 *   nested domain transactions roll back only their own writes. The executor
 *   never retries; retry ownership stays with the engine (`batchRetry`).
 * - Parameters: positional only. Arrays bind as SQL arrays (`= ANY($n::type[])`,
 *   never an expanded `IN ($1, ...)`), `Date` as its instant, `bigint` exactly
 *   through an explicit `::bigint` cast, `null` as NULL, vectors as text
 *   literals cast in SQL, JSONB through `jsonbParam()` (postgres.js `sql.json`
 *   on Postgres) or `$n::text::jsonb` with a serialized string. The E5 matrix
 *   (`test/helpers/executor-binding-matrix.ts`) pins each kind on every backend.
 * - Results: `{ rows, affectedRows }` (EO18). Domain code never reads the
 *   driver's `.count` / `.affectedRows`.
 * - Errors pass through unchanged (class, `.code`, message); nothing here catches.
 * - Cancellation: `signal` is forwarded only where the engine forwarded it on
 *   master; a pre-aborted signal rejects with `AbortError` before running.
 * - Driver options (EO2 / EO6 / EO9): `query` / `run` are the converted
 *   tagged-template statements (Postgres: prepared, extended protocol, no pool
 *   gauge). `executeRaw` and `unsafe` reproduce the two raw paths master used
 *   (engine `executeRaw`, which counts the `raw` gauge; direct `conn.unsafe`)
 *   for statements that were already raw on master.
 */

import type { SqlFragment } from './fragment.ts';

export type Row = Record<string, unknown>;

/** EO18 result envelope. `affectedRows` is 0 when the driver reports no count. */
export interface ExecResult<R = Row> {
  rows: R[];
  affectedRows: number;
}

export interface QueryOpts {
  signal?: AbortSignal;
}

/**
 * Engine differences a domain must branch on, stated as capabilities rather
 * than `if (dialect === ...)` (docs/designs/refactor-wave-1/w1-inventory.md).
 */
export interface DialectCapabilities {
  /**
   * Upper bound on bind parameters one batched write statement may carry.
   * PGLite's parameter bridge corrupts the session past the signed int16
   * ceiling (32,767), so PGLite batches below 30,000. Postgres never batched
   * on master: `Infinity` keeps one statement per write.
   */
  readonly maxBindParamsPerStatement: number;
  /**
   * Whether a write serializes concurrent writers with a transaction-scoped
   * advisory lock (`pg_advisory_xact_lock`). Postgres does; PGLite is a
   * single-connection embedded database and never needed one.
   */
  readonly transactionAdvisoryLocks: boolean;
  /**
   * Whether the embedding cast is probed per column (`vector` vs `halfvec`).
   * Postgres resolves it from the live column type (pgvector < 0.7 has no
   * vector->halfvec cast); PGLite never probed on master: it always casts
   * `::vector` and relies on its bundled pgvector's assignment cast.
   */
  readonly probesEmbeddingCast: boolean;
}

export interface SqlExecutor {
  readonly dialect: 'pglite' | 'postgres';
  readonly capabilities: DialectCapabilities;
  /** A converted statement: positional text + params. */
  query<R = Row>(sql: string, params?: readonly unknown[], opts?: QueryOpts): Promise<ExecResult<R>>;
  /** `query` over a composed fragment. */
  run<R = Row>(fragment: SqlFragment, opts?: QueryOpts): Promise<ExecResult<R>>;
  /** Master's `engine.executeRaw` path (Postgres counts the `raw` gauge). Rows only. */
  executeRaw<R = Row>(sql: string, params?: unknown[], opts?: QueryOpts): Promise<R[]>;
  /** Master's direct `conn.unsafe(sql, params)` path (default driver options, no gauge). */
  unsafe<R = Row>(sql: string, params: readonly unknown[]): Promise<ExecResult<R>>;
  /** BEGIN on a root handle, a savepoint inside a transaction. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

const JSONB_PARAM = Symbol('gbrain.engine-sql.jsonb');

/** A JSONB value bound as postgres.js `sql.json(value)` on Postgres. */
export interface JsonbParam {
  readonly [JSONB_PARAM]: true;
  readonly value: unknown;
}

export function jsonbParam(value: unknown): JsonbParam {
  return { [JSONB_PARAM]: true, value };
}

export function isJsonbParam(value: unknown): value is JsonbParam {
  return typeof value === 'object' && value !== null && JSONB_PARAM in value;
}

/** Shared pre-abort check: reject before any work, like `executeRaw` on both engines. */
export function throwIfAborted(opts?: QueryOpts): void {
  if (opts?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
}
