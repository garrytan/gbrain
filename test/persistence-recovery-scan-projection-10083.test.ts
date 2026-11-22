/** #10083: the recovery scan names rows to recover; it must not download each row's intent and recovery payload. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { initializeFixtures, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-recovery-scan-'));
const config: HarnessConfig = {
  kind: 'pglite', root: home, dataDir: join(home, 'data'), hostId: randomUUID(),
  seed: 10083, schedules: 0, operations: 0, sourceIds: ['recovery-scan'], principalIds: [randomUUID()],
};
const env = { GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home };
let engine: PGLiteEngine;

beforeAll(async () => withEnv(env, async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  selectFixtureHost(config.hostId);
  await initializeFixtures(engine, config);
}), 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

test('the recovery scan does not select whole journal rows', async () => withEnv(env, async () => {
  const statements: string[] = [];
  const proxy = new Proxy(engine, { get(obj, key) {
    if (key === 'executeRaw') return (sql: string, ...rest: unknown[]) => {
      statements.push(sql);
      return (obj.executeRaw as (...args: unknown[]) => Promise<unknown>)(sql, ...rest);
    };
    const value = Reflect.get(obj, key);
    return typeof value === 'function' ? value.bind(obj) : value;
  } });
  const consumer = new PersistenceConsumer(proxy, { engine: 'pglite' }, async () => { throw new Error('no work expected'); },
    { hostId: config.hostId, onError: () => {} });
  try {
    await consumer.tick();
    await Promise.all(['projectionWorker', 'effectsWorker', 'topologyWorker', 'maintenanceWorker']
      .map(name => (consumer as unknown as Record<string, Promise<unknown> | undefined>)[name]));
  } finally { await consumer.stop(); }
  const scans = statements.filter(sql => /FROM persistence_requests r\s+JOIN persistence_worktrees w/.test(sql) && sql.includes('r.recovery IS NOT NULL'));
  expect(scans.length).toBeGreaterThan(0);
  for (const sql of scans) expect(sql).not.toMatch(/SELECT\s+r\.\*/);
}));
