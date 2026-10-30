/**
 * Vector index prewarm on real Postgres (GBRA-156, core/vector-prewarm.ts):
 * a small brain's HNSW indexes fit the test server's shared_buffers and are
 * prewarmed block for block; the same brain under a simulated small
 * shared_buffers (the settings statement reads a 16 kB literal in its place,
 * everything else runs on the real server) is refused before any pg_prewarm
 * call; without the extension the command refuses with its own code.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { readVectorPrewarmPlan, runVectorPrewarm } from '../../src/core/vector-prewarm.ts';

const RUN = hasDatabase();
let engine: PostgresEngine;

/** The real engine, recording every statement; with `sharedBuffers` the settings statement reads that literal instead of the server's value. */
function recording(sharedBuffers?: string): { engine: BrainEngine; statements: string[] } {
  const statements: string[] = [];
  const wrap = (target: BrainEngine): BrainEngine => new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === 'executeRaw') {
        return (sql: string, params?: unknown[]) => {
          statements.push(sql);
          const run = sharedBuffers ? sql.replace("current_setting('shared_buffers')", `'${sharedBuffers}'::text`) : sql;
          return t.executeRaw(run, params);
        };
      }
      if (prop === 'transaction') return (fn: (e: BrainEngine) => Promise<unknown>) => t.transaction(tx => fn(wrap(tx)));
      const value = Reflect.get(t, prop, receiver);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
  return { engine: wrap(engine), statements };
}

describe.skipIf(!RUN)('vector index prewarm on Postgres', () => {
  beforeAll(async () => {
    engine = await setupDB();
    await engine.executeRaw('DROP EXTENSION IF EXISTS pg_prewarm');
  });
  afterAll(async () => {
    await engine.executeRaw('DROP EXTENSION IF EXISTS pg_prewarm');
    await teardownDB();
  });

  test('the plan reads the brain HNSW indexes, shared_buffers and effective_cache_size', async () => {
    const plan = await readVectorPrewarmPlan(engine);
    const [settings] = await engine.executeRaw<{ sb: string }>("SELECT pg_size_bytes(current_setting('shared_buffers'))::text AS sb");
    expect(plan.indexes.map(i => i.index)).toContain('idx_chunks_embedding');
    expect(plan.shared_buffers_bytes).toBe(Number(settings!.sb));
    expect(plan.effective_cache_size_bytes).toBeGreaterThan(0);
    expect(plan.fits).toBe(true);
    expect(plan.extension_available).toBe(true);
  });

  test('without the extension it refuses and calls no pg_prewarm', async () => {
    const r = recording();
    let code: string | undefined;
    try { await runVectorPrewarm(r.engine); } catch (e) { code = (e as { canonicalCode?: string }).canonicalCode; }
    expect(code).toBe('vector_prewarm_extension_missing');
    expect(r.statements.some(s => s.includes('pg_prewarm('))).toBe(false);
  });

  test('a small shared_buffers refuses before any pg_prewarm call', async () => {
    await engine.executeRaw('CREATE EXTENSION IF NOT EXISTS pg_prewarm');
    const r = recording('16kB');
    let code: string | undefined;
    try { await runVectorPrewarm(r.engine); } catch (e) { code = (e as { canonicalCode?: string }).canonicalCode; }
    expect(code).toBe('vector_prewarm_wont_fit');
    expect(r.statements.some(s => s.includes('pg_prewarm('))).toBe(false);
    expect(r.statements).toHaveLength(2);
  });

  test('a fitting brain is prewarmed into shared_buffers, every block of every HNSW index', async () => {
    await engine.executeRaw('CREATE EXTENSION IF NOT EXISTS pg_prewarm');
    const r = recording();
    const result = await runVectorPrewarm(r.engine);
    expect(result.loaded.map(l => l.index)).toEqual(result.indexes.map(i => i.index));
    for (const ix of result.indexes) expect(result.loaded.find(l => l.index === ix.index)!.blocks).toBe(ix.bytes / 8192);
    expect(r.statements.filter(s => s.includes('pg_prewarm(')).length).toBe(result.indexes.length);
  });

  test('a dry run reads nothing', async () => {
    const r = recording();
    const result = await runVectorPrewarm(r.engine, { dryRun: true });
    expect(result.loaded).toEqual([]);
    expect(r.statements.some(s => s.includes('pg_prewarm('))).toBe(false);
  });
});
