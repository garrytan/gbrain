/**
 * GBRA-156: serial round trips of PGLite statements.
 *
 * Every statement is held `delayMs` (a stand-in for the network round trip) and records its depth: one more than the
 * deepest statement already answered when it was sent. Statements sent together share a depth, so the deepest depth of
 * a request is the number of serial round trips it pays, whatever the machine's speed. With `scope`, each statement
 * records the scope it was sent from and counts only statements of that scope, so concurrent background work neither
 * deepens nor joins a request's round trips.
 */
import type { PGLiteEngine } from '../../src/core/pglite-engine.ts';

export interface DepthRecord { sql: string; depth: number; scope?: unknown }

export function recordStatementDepth(engine: PGLiteEngine, opts: { delayMs?: number; onRecord?: (record: DepthRecord) => void; scope?: () => unknown } = {}): { records: DepthRecord[]; reset(): void } {
  const db = engine.db as unknown as { query: (sql: string, ...rest: unknown[]) => Promise<unknown> };
  const query = db.query.bind(db);
  const records: DepthRecord[] = [];
  const answered = new Map<unknown, number>();
  db.query = async (sql: string, ...rest: unknown[]) => {
    const scope = opts.scope?.();
    const record: DepthRecord = { sql: sql.replace(/\s+/g, ' ').trim(), depth: (answered.get(scope) ?? 0) + 1 };
    if (opts.scope) record.scope = scope;
    records.push(record);
    opts.onRecord?.(record);
    await Bun.sleep(opts.delayMs ?? 5);
    try { return await query(sql, ...rest); } finally { answered.set(scope, Math.max(answered.get(scope) ?? 0, record.depth)); }
  };
  return { records, reset: () => { records.length = 0; answered.clear(); } };
}
