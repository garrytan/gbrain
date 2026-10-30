/**
 * GBRA-156: serial round trips of PGLite statements.
 *
 * Every statement is held `delayMs` (a stand-in for the network round trip) and records its depth: one more than the
 * deepest statement already answered when it was sent. Statements sent together share a depth, so the deepest depth of
 * a request is the number of serial round trips it pays, whatever the machine's speed.
 */
import type { PGLiteEngine } from '../../src/core/pglite-engine.ts';

export interface DepthRecord { sql: string; depth: number }

export function recordStatementDepth(engine: PGLiteEngine, opts: { delayMs?: number; onRecord?: (record: DepthRecord) => void } = {}): { records: DepthRecord[]; reset(): void } {
  const db = engine.db as unknown as { query: (sql: string, ...rest: unknown[]) => Promise<unknown> };
  const query = db.query.bind(db);
  const records: DepthRecord[] = [];
  let answered = 0;
  db.query = async (sql: string, ...rest: unknown[]) => {
    const record = { sql: sql.replace(/\s+/g, ' ').trim(), depth: answered + 1 };
    records.push(record);
    opts.onRecord?.(record);
    await Bun.sleep(opts.delayMs ?? 5);
    try { return await query(sql, ...rest); } finally { answered = Math.max(answered, record.depth); }
  };
  return { records, reset: () => { records.length = 0; answered = 0; } };
}
