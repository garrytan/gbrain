/**
 * #5854: managed maintenance publishes wait one shared 30 s budget per job
 * (bounded by the job deadline), and after the first publish that is still
 * pending the job's later publishes do not wait.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { maintenancePreflight, publishMaintenancePage } from '../src/core/persistence/prepared-maintenance.ts';
import { MAINTENANCE_WRITE_WAIT_MS, MaintenanceWriteWait, __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-maintenance-wait-db-'));
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
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
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

async function fixture(run: (engine: BrainEngine, sourceId: string) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-maintenance-wait-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `wait-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run(engine, sourceId);
      });
    } finally {
      __setMaintenanceWriteWaitForTests(null);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const page = (n: number) => `---\ntitle: Maintenance ${n}\ntype: note\n---\nMaintenance output ${n}.`;

async function pendingAfter(publish: Promise<unknown>): Promise<{ ms: number; code: string | null }> {
  const started = performance.now();
  const code = await publish.then(() => null, (error: unknown) => error instanceof OperationError ? error.code : String(error));
  return { ms: performance.now() - started, code };
}

test('the wait is 30 s, bounded by the job deadline, and zero after a pending publish', () => {
  expect(MAINTENANCE_WRITE_WAIT_MS).toBe(30_000);
  let now = 1_000;
  expect(new MaintenanceWriteWait().ms()).toBe(30_000);
  const bounded = new MaintenanceWriteWait(now + 12_000, () => now);
  expect(bounded.ms()).toBe(12_000);
  now += 13_000;
  expect(bounded.ms()).toBe(0);
  const wait = new MaintenanceWriteWait();
  wait.observe({ state: 'committed' } as WriteRequest);
  expect(wait.ms()).toBe(30_000);
  wait.observe({ state: 'queued' } as WriteRequest);
  expect(wait.ms()).toBe(0);
});

test('a maintenance publish commits when the writer frees up after 6.5 s (the old 5 s wait returned write_pending)', async () => {
  await fixture(async (engine, sourceId) => {
    const authority = (await maintenancePreflight(engine, sourceId))!;
    const lock = (await acquireWorktree((await getWorktreeBinding(engine, sourceId))!, 1000))!;
    const release = setTimeout(() => { void lock.release(); }, 6_500);
    try {
      const receipt = await publishMaintenancePage(engine, authority, 'wiki/maintenance-wait', page(1), { expectedRevision: null });
      expect((receipt.write_request as { state: string }).state).toBe('committed');
    } finally { clearTimeout(release); await lock.release(); }
    expect((await engine.getPage('wiki/maintenance-wait', { sourceId }))?.compiled_truth).toContain('Maintenance output 1.');
  });
}, 60_000);

test('after the first pending publish, the job\'s later publishes do not wait; both commit once the writer frees up', async () => {
  await fixture(async (engine, sourceId) => {
    __setMaintenanceWriteWaitForTests(600);
    const authority = (await maintenancePreflight(engine, sourceId))!;
    const lock = (await acquireWorktree((await getWorktreeBinding(engine, sourceId))!, 1000))!;
    const waits = spyOn(MaintenanceWriteWait.prototype, 'ms');
    let first: Awaited<ReturnType<typeof pendingAfter>>, second: Awaited<ReturnType<typeof pendingAfter>>;
    let waited: number[];
    try {
      first = await pendingAfter(publishMaintenancePage(engine, authority, 'wiki/wait-first', page(1), { expectedRevision: null }));
      second = await pendingAfter(publishMaintenancePage(engine, authority, 'wiki/wait-second', page(2), { expectedRevision: null }));
      waited = waits.mock.results.map(call => call.value as number);
    } finally { waits.mockRestore(); await lock.release(); }
    expect(first.code).toBe('write_pending');
    expect(first.ms).toBeGreaterThanOrEqual(550);
    expect(second.code).toBe('write_pending');
    expect(waited).toEqual([600, 0]);
    const fresh = (await maintenancePreflight(engine, sourceId))!;
    for (const [slug, n] of [['wiki/wait-first', 1], ['wiki/wait-second', 2]] as const) {
      const receipt = await publishMaintenancePage(engine, fresh, slug, page(n), { expectedRevision: null });
      expect((receipt.write_request as { state: string }).state).toBe('committed');
    }
    expect(await engine.executeRaw("SELECT slug FROM persistence_requests WHERE source_id=$1 AND state='committed' ORDER BY slug", [sourceId]))
      .toEqual([{ slug: 'wiki/wait-first' }, { slug: 'wiki/wait-second' }]);
  });
}, 60_000);

test('a job at its deadline publishes without waiting and defers the write', async () => {
  await fixture(async (engine, sourceId) => {
    const authority = (await maintenancePreflight(engine, sourceId, undefined, { deadlineAtMs: Date.now() - 1 }))!;
    const lock = (await acquireWorktree((await getWorktreeBinding(engine, sourceId))!, 1000))!;
    const waits = spyOn(MaintenanceWriteWait.prototype, 'ms');
    let result: Awaited<ReturnType<typeof pendingAfter>>;
    let states: Array<{ state: string }>;
    let waited: number[];
    try {
      result = await pendingAfter(publishMaintenancePage(engine, authority, 'wiki/wait-deadline', page(3), { expectedRevision: null }));
      waited = waits.mock.results.map(call => call.value as number);
      states = await engine.executeRaw("SELECT state FROM persistence_requests WHERE source_id=$1 AND slug='wiki/wait-deadline'", [sourceId]);
    } finally { waits.mockRestore(); await lock.release(); }
    expect(result.code).toBe('write_pending');
    expect(waited).toEqual([0]);
    expect(states).toHaveLength(1);
    expect(states[0].state).not.toBe('committed');
  });
}, 60_000);
