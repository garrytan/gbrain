/**
 * Hot memory never outlives a forget (eval wave N5-1).
 *
 * `_meta.brain_hot_memory` and context_pack's hot facts come from a 30 s
 * per-process cache. A mutating tool call through dispatch (every MCP
 * transport) drops the engine's entries, every hit revalidates the source's
 * withdrawal-ledger watermark (so a forget committed by another process is
 * not served either), and a build that raced an invalidation is not stored.
 * Both visibility tiers are checked.
 *
 * Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import {
  getBrainHotMemoryMeta, invalidateHotMemoryForEngine, __hotMemoryCacheForTests, __resetHotMemoryCacheForTests,
} from '../src/core/facts/meta-hook.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-hot-memory-'));
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.(); rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => { __resetHotMemoryCacheForTests(); });

const ENTITY = 'people/alice-example';
let seq = 0;
async function seed(engine: BrainEngine): Promise<{ id: number; marker: string }> {
  const marker = `cnryhot${++seq}${Math.random().toString(36).slice(2, 8)}`;
  const { id } = await engine.insertFact(
    { fact: `Keeps bees ${marker}`, kind: 'fact', entity_slug: ENTITY, visibility: 'world', source: 'test' },
    { source_id: 'default' });
  return { id, marker };
}
const call = (engine: BrainEngine, name: string, params: Record<string, unknown>, remote: boolean) =>
  dispatchToolCall(engine, name, params, { remote, sourceId: 'default', transport: remote ? 'stdio' : undefined, metaHook: getBrainHotMemoryMeta });
const metaCarries = async (engine: BrainEngine, marker: string, remote: boolean) =>
  JSON.stringify((await call(engine, 'get_stats', {}, remote))._meta ?? null).includes(marker);
const packCarries = async (engine: BrainEngine, marker: string, remote: boolean) =>
  (await call(engine, 'context_pack', { entities: ENTITY }, remote)).content.map(c => c.text).join('\n').includes(marker);
const ctx = (engine: BrainEngine, remote: boolean): OperationContext =>
  ({ engine, remote, sourceId: 'default', config: {} as never, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

test('a forget through dispatch clears hot memory for both tiers, in _meta and context_pack', async () => {
  for (const engine of engines) {
    const { id, marker } = await seed(engine);
    for (const remote of [true, false]) {
      expect(await metaCarries(engine, marker, remote)).toBe(true);
      expect(await packCarries(engine, marker, remote)).toBe(true);
    }
    const forgotten = await call(engine, 'forget', { id: String(id), reason: 'test' }, false);
    expect(forgotten.isError).toBeFalsy();
    for (const remote of [true, false]) {
      expect(await metaCarries(engine, marker, remote)).toBe(false);
      expect(await packCarries(engine, marker, remote)).toBe(false);
    }
  }
});

test('a withdrawal committed outside this dispatcher (another process) is not served from the cache', async () => {
  for (const engine of engines) {
    const { id, marker } = await seed(engine);
    for (const remote of [true, false]) {
      expect(JSON.stringify(await getBrainHotMemoryMeta('get_stats', ctx(engine, remote)))).toContain(marker);
    }
    expect((await recordFactWithdrawal(engine, id, 'default')).withdrawn).toBe(true);
    for (const remote of [true, false]) {
      expect(JSON.stringify(await getBrainHotMemoryMeta('get_stats', ctx(engine, remote)) ?? null)).not.toContain(marker);
    }
  }
});

test('a fact written through dispatch shows up on the next response', async () => {
  for (const engine of engines) {
    await seed(engine);
    expect(await metaCarries(engine, 'cnryfreshwrite', false)).toBe(false);
    const remembered = await call(engine, 'remember', { fact: 'Plays the oboe cnryfreshwrite', entity: ENTITY, provenance: 'test', visibility: 'world' }, false);
    expect(remembered.isError).toBeFalsy();
    expect(await metaCarries(engine, 'cnryfreshwrite', false)).toBe(true);
    expect(await metaCarries(engine, 'cnryfreshwrite', true)).toBe(true);
  }
});

test('a build that raced an invalidation is not cached', async () => {
  for (const engine of engines) {
    await seed(engine);
    const racing = Object.create(engine) as BrainEngine;
    racing.listFactsSince = async (...args: Parameters<BrainEngine['listFactsSince']>) => {
      invalidateHotMemoryForEngine(racing);
      return engine.listFactsSince(...args);
    };
    expect(await getBrainHotMemoryMeta('get_stats', ctx(racing, false))).toBeDefined();
    expect(__hotMemoryCacheForTests().size).toBe(0);
  }
});
