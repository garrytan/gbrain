/**
 * A SqlQuery over `engine` whose UPDATE statements fail as a read-only database refuses them (code 25006), while the
 * engine's typed members still answer. The bearer check reads a token's sources through the typed members of the
 * engine behind its `sql` (sql-query.ts engineOfSqlQuery), so a hand-rolled wrapper tag would lose them.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { sqlQueryForEngine, type SqlQuery } from '../../src/core/sql-query.ts';

export function readOnlySqlFor(engine: BrainEngine): SqlQuery {
  const refuse = () => Promise.reject(Object.assign(new Error('cannot execute UPDATE in a read-only transaction'), { code: '25006' }));
  return sqlQueryForEngine(new Proxy(engine, { get: (e, k) => k === 'executeRaw'
    ? (q: string, p?: unknown[]) => /^\s*UPDATE/i.test(q) ? refuse() : e.executeRaw(q, p)
    : typeof Reflect.get(e, k) === 'function' ? Reflect.get(e, k).bind(e) : Reflect.get(e, k) }));
}
