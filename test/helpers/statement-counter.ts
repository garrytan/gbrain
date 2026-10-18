/**
 * #6712 PR 3 (L6): the statement counter both engines' budget tests read.
 *
 * Postgres: the env-gated wire trace (`GBRAIN_SQL_TRACE`, src/core/sql-trace.ts)
 * records every round trip at the socket; `readSqlTrace` loads it. PGLite has
 * no socket, so `countPgliteStatements` wraps the datastore's
 * `execProtocolRaw` (every PGLite query, named or unnamed, every simple query
 * and the transaction's BEGIN and COMMIT go through it) and decodes the frontend messages the same way the wire
 * trace does: an Execute or a simple Query is one statement, carrying the text
 * its Parse named. Both produce the same `StatementRecord` shape, so one
 * classifier serves both engines.
 */
import { readFileSync } from 'node:fs';
import type { PGLiteEngine } from '../../src/core/pglite-engine.ts';

export interface StatementRecord { t: number; conn: number; kind: string; sql: string; ms?: number }

/** Statement records of a `GBRAIN_SQL_TRACE` file (round trips: `execute`, `simple`, `describe`, `connect`). */
export function readSqlTrace(file: string): StatementRecord[] {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as StatementRecord);
}

function cstring(buf: Uint8Array, at: number): [string, number] {
  let end = at;
  while (end < buf.length && buf[end] !== 0) end++;
  return [Buffer.from(buf.buffer, buf.byteOffset + at, end - at).toString('utf8'), end + 1];
}

/** Counts the statements one PGLite engine sends until `stop()`. */
export function countPgliteStatements(engine: PGLiteEngine): { records: StatementRecord[]; stop(): StatementRecord[] } {
  const db = engine.db as unknown as { execProtocolRaw: (message: Uint8Array, opts?: unknown) => Promise<unknown> };
  const original = db.execProtocolRaw;
  const prepared = new Map<string, string>();
  const records: StatementRecord[] = [];
  let text = '';
  let t = 0;
  db.execProtocolRaw = function (this: unknown, message: Uint8Array, opts?: unknown) {
    for (let at = 0; at + 5 <= message.length;) {
      const type = message[at]!;
      const length = new DataView(message.buffer, message.byteOffset + at + 1, 4).getInt32(0);
      const body = message.subarray(at + 5, at + 1 + length);
      if (type === 0x50) { const [name, next] = cstring(body, 0); text = cstring(body, next)[0]; prepared.set(name, text); }
      else if (type === 0x42) { const [, next] = cstring(body, 0); text = prepared.get(cstring(body, next)[0]) ?? text; }
      else if (type === 0x45) records.push({ t: ++t, conn: 1, kind: 'execute', sql: text });
      else if (type === 0x51) records.push({ t: ++t, conn: 1, kind: 'simple', sql: cstring(body, 0)[0] });
      at += 1 + length;
    }
    return original.call(this, message, opts);
  };
  return { records, stop: () => { db.execProtocolRaw = original; return records; } };
}
