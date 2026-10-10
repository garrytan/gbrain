/**
 * PGLite queue upkeep vacuums a queue table only once its heap has grown more
 * than 10% (and 8 pages) past the size its last VACUUM or ANALYZE recorded, so
 * a short-lived CLI process does not vacuum every queue on its first tick.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { vacuumPersistenceQueues } from '../src/core/persistence/journal.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

async function vacuumed(): Promise<string[]> {
  const seen: string[] = [];
  const original = engine.executeRaw;
  engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[], opts?: unknown) {
    if (sql.startsWith('VACUUM')) seen.push(sql);
    return original.call(this, sql, params, opts as never);
  } as BrainEngine['executeRaw'];
  try { await vacuumPersistenceQueues(engine); } finally { engine.executeRaw = original; }
  return seen;
}
const pages = async () => (await engine.executeRaw<{ relpages: number; size: number }>(
  "SELECT relpages, pg_relation_size('persistence_counters'::regclass) / current_setting('block_size')::int AS size FROM pg_class WHERE oid = 'persistence_counters'::regclass"))[0]!;

test('small queues are left alone; a queue that grew past its recorded size is vacuumed once, then left alone', async () => {
  expect(await vacuumed()).toEqual([]);
  await engine.executeRaw("INSERT INTO persistence_counters(key) SELECT 'bench-' || g FROM generate_series(1, 3000) g");
  expect((await pages()).size).toBeGreaterThan(8);
  expect(await vacuumed()).toEqual(['VACUUM (ANALYZE) persistence_counters']);
  const after = await pages();
  expect(after.relpages).toBe(after.size);
  expect(await vacuumed()).toEqual([]);
  await engine.executeRaw("UPDATE persistence_counters SET lifetime_ids = lifetime_ids + 1 WHERE key LIKE 'bench-%'");
  expect(await vacuumed()).toEqual(['VACUUM (ANALYZE) persistence_counters']);
  await engine.executeRaw("DELETE FROM persistence_counters WHERE key LIKE 'bench-%'");
});
