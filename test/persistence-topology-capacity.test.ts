import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { tryAcquirePoolLongHold } from '../src/core/pool-budget.ts';
import { tryAcquirePublicationCapacity } from '../src/core/persistence/pool-capacity.ts';
import { topologyTransaction } from '../src/core/persistence/topology-transaction.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
let pg: PostgresEngine | undefined;
let single: PostgresEngine | undefined;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL); pg = fixture.engine; closePostgres = fixture.close; engines.push(pg);
    const [{ database }] = await pg.executeRaw<{ database: string }>('SELECT current_database() AS database');
    const url = new URL(process.env.DATABASE_URL); url.pathname = `/${database}`;
    single = new PostgresEngine(); await single.connect({ database_url: url.toString(), poolSize: 1 });
  }
}, 120_000);
afterAll(async () => { await single?.disconnect(); for (const engine of engines) await engine.disconnect(); await closePostgres?.(); });

test('topology transactions use durable bounded SQL and reuse their permit when helpers nest', async () => {
  for (const engine of engines) {
    await topologyTransaction(engine, async tx => {
      const [settings] = await tx.executeRaw<{ commit: string; lock: string; statement: string }>("SELECT current_setting('synchronous_commit') AS commit,current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement");
      expect(settings).toEqual({ commit: 'on', lock: '1s', statement: '5s' });
      await tx.executeRaw("INSERT INTO config(key,value) VALUES('test.topology_nested','outer')");
      await topologyTransaction(engine, async nested => {
        expect((await nested.executeRaw<{ value: string }>("SELECT value FROM config WHERE key='test.topology_nested'"))[0].value).toBe('outer');
        await nested.executeRaw("UPDATE config SET value='inner' WHERE key='test.topology_nested'");
      });
      expect((await tx.executeRaw<{ value: string }>("SELECT value FROM config WHERE key='test.topology_nested'"))[0].value).toBe('inner');
    });
    expect(await engine.getConfig('test.topology_nested')).toBe('inner');
    await expect(topologyTransaction(engine, async tx => { await tx.executeRaw("UPDATE config SET value='rollback' WHERE key='test.topology_nested'"); throw new Error('cancelled phase'); })).rejects.toThrow('cancelled phase');
    expect(await engine.getConfig('test.topology_nested')).toBe('inner');
    // Failure releases capacity; the next real transaction can publish.
    expect(await topologyTransaction(engine, async tx => (await tx.executeRaw<{ value: number }>('SELECT 42 AS value'))[0].value)).toBe(42);
  }
});

test('occupied publication capacity refuses topology before checkout and preserves the actual control connection', async () => {
  for (const engine of engines) {
    const releases = [tryAcquirePublicationCapacity(engine)];
    if (engine.kind === 'postgres') releases.push(tryAcquirePublicationCapacity(engine), tryAcquirePoolLongHold((engine as PostgresEngine).sql));
    expect(releases.every(Boolean)).toBe(true);
    const holds: Promise<void>[] = [], ready: Promise<void>[] = [];
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    try {
      if (engine.kind === 'postgres') for (const _ of releases) {
        let started!: () => void; ready.push(new Promise<void>(resolve => { started = resolve; }));
        holds.push(engine.transaction(async tx => { await tx.executeRaw('SELECT 1'); started(); await gate; }));
      }
      await Promise.all(ready);
      let entered = false;
      await expect(topologyTransaction(engine, async () => { entered = true; })).rejects.toMatchObject({ code: 'writer_pool_capacity' });
      expect(entered).toBe(false);
      expect((await engine.executeRaw<{ value: number }>('SELECT 42 AS value'))[0].value).toBe(42);
    } finally { finish(); await Promise.all(holds); for (const release of releases) release?.(); }
    expect(await topologyTransaction(engine, async () => 'resumed')).toBe('resumed');
  }
});

test.skipIf(!process.env.DATABASE_URL)('ordinary pool size one declines topology publication before starting a transaction', async () => {
  let entered = false;
  await expect(topologyTransaction(single!, async () => { entered = true; })).rejects.toMatchObject({ code: 'writer_pool_capacity' });
  expect(entered).toBe(false);
  expect((await single!.executeRaw<{ value: number }>('SELECT 42 AS value'))[0].value).toBe(42);
});

test.skipIf(!process.env.DATABASE_URL)('a contended topology SQL guard times out and frees publication capacity', async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const holder = single!.transaction(async tx => { await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE'); started(); await gate; });
  await ready;
  try {
    const beginning = performance.now();
    await expect(topologyTransaction(pg!, tx => tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE'))).rejects.toMatchObject({ code: 'write_pending' });
    expect(performance.now() - beginning).toBeLessThan(4000);
    expect((await pg!.executeRaw<{ value: number }>('SELECT 42 AS value'))[0].value).toBe(42);
  } finally { release(); await holder; }
  expect(await topologyTransaction(pg!, async () => 'released')).toBe('released');
}, 10_000);
