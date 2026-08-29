/**
 * PGLite disconnect issues a best-effort CHECKPOINT before close() (#3893,
 * reimplemented from @y2688's PR).
 *
 * PGLite is in-process WASM: when close() times out or wedges (the #4143
 * class) the handle is abandoned and dies with the process, losing any WAL
 * not yet flushed into the data files. A pre-close CHECKPOINT makes the
 * data files current so an abandoned close loses no committed rows. This is
 * deliberately PGLite-only (no postgres-engine parity twin): a server
 * Postgres owns its own checkpointer and survives this process dying.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

type RawHandle = {
  query(sql: string, ...rest: unknown[]): Promise<unknown>;
  close(): Promise<void>;
};

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
});

afterAll(async () => {
  // The test below already disconnects; a second disconnect is a no-op
  // (db and lock are both null). Kept for the R4 no-leak contract.
  await engine.disconnect();
});

describe('PGLiteEngine.disconnect — pre-close WAL checkpoint (#3893)', () => {
  test('CHECKPOINT runs on the live handle, and before close()', async () => {
    const raw = (engine as unknown as { _db: RawHandle })._db;
    expect(raw).toBeTruthy();

    const events: string[] = [];
    const origQuery = raw.query.bind(raw);
    raw.query = ((sql: string, ...rest: unknown[]) => {
      events.push(`query:${sql}`);
      return origQuery(sql, ...rest);
    }) as RawHandle['query'];
    const origClose = raw.close.bind(raw);
    raw.close = (() => {
      events.push('close');
      return origClose();
    }) as RawHandle['close'];

    await engine.disconnect();

    const checkpointIdx = events.findIndex(e => e === 'query:CHECKPOINT');
    const closeIdx = events.indexOf('close');
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    // Red pre-#3893: no CHECKPOINT was ever issued (checkpointIdx === -1).
    expect(checkpointIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThan(checkpointIdx);
  }, 30_000);
});
