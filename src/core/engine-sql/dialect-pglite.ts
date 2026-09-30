/**
 * PGLite dialect adapter for the engine-sql executor (refactor wave 1, W1 / A4).
 *
 * Wraps one PGLite handle: the engine's attached `db` (statement cache +
 * checkpoint admission already applied by `PGLiteEngine`) or a transaction
 * handle. `PGLiteEngine#engineSql` builds a fresh adapter over `this.db` on
 * every access (EO1), so a transaction clone's executor runs on the clone's
 * handle.
 */

import type { PGlite, Transaction } from '@electric-sql/pglite';
import { renderFragment, type SqlFragment } from './fragment.ts';
import {
  isJsonbParam,
  throwIfAborted,
  type DialectCapabilities,
  type ExecResult,
  type QueryOpts,
  type Row,
  type SqlExecutor,
} from './executor.ts';

type PgliteHandle = Pick<PGlite, 'query'> & Partial<Pick<PGlite, 'transaction'>>;

export const PGLITE_CAPABILITIES: DialectCapabilities = {
  maxBindParamsPerStatement: 30_000,
  transactionAdvisoryLocks: false,
  probesEmbeddingCast: false,
};

function bind(params: readonly unknown[] | undefined): unknown[] {
  if (!params) return [];
  return params.map((p) => (isJsonbParam(p) ? JSON.stringify(p.value) : p));
}

/**
 * PGLite runs a statement synchronously inside WASM with no kernel-level
 * cancellation: pre-check the signal, then race the settle promise against a
 * late abort (the statement finishes; its result is discarded). The same
 * contract `PGLiteEngine#executeRaw` documents in engine.ts.
 */
export async function pgliteQuery<R = Row>(
  db: Pick<PGlite, 'query'>,
  sql: string,
  params: readonly unknown[] | undefined,
  opts?: QueryOpts,
): Promise<ExecResult<R>> {
  throwIfAborted(opts);
  const pending = db.query<R>(sql, bind(params)).then((r) => ({ rows: r.rows, affectedRows: r.affectedRows ?? 0 }));
  if (!opts?.signal) return pending;
  const signal = opts.signal;
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  return Promise.race([pending, aborted]);
}

export function pgliteExecutor(db: PgliteHandle): SqlExecutor {
  return {
    dialect: 'pglite',
    capabilities: PGLITE_CAPABILITIES,
    query: <R = Row>(sql: string, params?: readonly unknown[], opts?: QueryOpts) => pgliteQuery<R>(db, sql, params, opts),
    run<R = Row>(fragment: SqlFragment, opts?: QueryOpts) {
      const { text, params } = renderFragment(fragment);
      return pgliteQuery<R>(db, text, params, opts);
    },
    async executeRaw<R = Row>(sql: string, params?: unknown[], opts?: QueryOpts): Promise<R[]> {
      return (await pgliteQuery<R>(db, sql, params, opts)).rows;
    },
    unsafe: <R = Row>(sql: string, params: readonly unknown[]) => pgliteQuery<R>(db, sql, params),
    transaction(fn) {
      if (!db.transaction) throw new Error('engine-sql: this PGLite handle cannot open a transaction');
      return db.transaction((tx: Transaction) => fn(pgliteExecutor(tx)));
    },
  };
}
