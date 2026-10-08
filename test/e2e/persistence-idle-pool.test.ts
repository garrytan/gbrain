/**
 * #5370: an idle resident consumer must let its Postgres pool drain. Idle
 * probes share one reserved connection, every other pooled connection closes
 * through the engine's 20 s idle_timeout, and no LISTEN is involved, so the
 * transaction-mode PgBouncer path behaves the same as a direct server.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres'
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { PersistenceConsumer } from '../../src/core/persistence/consumer.ts';
import { admitWrite, getWriteRequestById } from '../../src/core/persistence/journal.ts';
import { admission, fixtures, initializeFixtures, prepared, selectFixtureHost, type HarnessConfig } from '../../scripts/persistence/harness.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { withEnv } from '../helpers/with-env.ts';
import { waitFor } from '../helpers/wait-for.ts';

const direct = process.env.DATABASE_URL;
const pooled = process.env.GBRAIN_PGBOUNCER_URL;
const pooledAdmin = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
if (process.env.GBRAIN_CI_REQUIRE_PGBOUNCER === '1' && !(pooled && pooledAdmin)) throw new Error('Idle pool drain requires the configured CI PgBouncer fixture.');
const IDLE_DRAIN_MS = 28_000;

async function scratchDatabase(adminUrl: string, clientUrl: string) {
  assertSafeE2eDatabaseUrl(adminUrl);
  const name = `gbrain_test_idle_pool_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(clientUrl);
  url.pathname = `/${name}`;
  return { name, admin, url: url.toString(),
    drop: async () => { try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); } } };
}

async function withConsumer(url: string, run: (engine: PostgresEngine, consumer: PersistenceConsumer, config: HarnessConfig) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-idle-pool-'));
  const config: HarnessConfig = { kind: 'postgres', root, dataDir: join(root, 'unused'), hostId: randomUUID(),
    seed: 5370, schedules: 0, operations: 0, sourceIds: ['idle-pool'], principalIds: [randomUUID()] };
  const engine = new PostgresEngine();
  try {
    await withEnv({ GBRAIN_HOME: root, GBRAIN_PERSISTENCE_FIXTURE_HOME: root }, async () => {
      await engine.connect({ database_url: url, poolSize: 4 });
      await engine.initSchema();
      selectFixtureHost(config.hostId);
      await initializeFixtures(engine, config);
      const sources = await fixtures(engine, config);
      const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, async (_e, row) => prepared(row, sources),
        { hostId: config.hostId });
      // Saturate the pool the way a busy tick does, then go idle.
      await Promise.all(Array.from({ length: 4 }, () => engine.executeRaw('SELECT pg_sleep(0.2)')));
      consumer.start();
      try { await run(engine, consumer, config); } finally { await consumer.stop(); }
    });
  } finally {
    await engine.disconnect();
    rmSync(root, { recursive: true, force: true });
  }
}

/** Established TCP sockets this process holds to host:port (Linux /proc). */
async function ownSockets(host: string, port: number): Promise<number> {
  const inodes = new Set<string>();
  for (const fd of readdirSync('/proc/self/fd')) {
    try { const link = readlinkSync(`/proc/self/fd/${fd}`); if (link.startsWith('socket:[')) inodes.add(link.slice(8, -1)); } catch { /* closed */ }
  }
  const { address, family } = await lookup(host);
  const want = family === 4
    ? address.split('.').map(part => Number(part).toString(16).padStart(2, '0')).reverse().join('').toUpperCase()
    : null;
  const portHex = port.toString(16).toUpperCase().padStart(4, '0');
  let count = 0;
  for (const table of ['/proc/self/net/tcp', '/proc/self/net/tcp6']) {
    if (!existsSync(table)) continue;
    for (const line of readFileSync(table, 'utf8').split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== '01' || !inodes.has(cols[9]!)) continue;
      const [remoteIp, remotePort] = cols[2]!.split(':');
      if (remotePort !== portHex) continue;
      if (want === null || remoteIp === want || remoteIp!.endsWith(want)) count++;
    }
  }
  return count;
}

describe.skipIf(!direct)('idle persistence consumer on PostgreSQL', () => {
  test('an idle consumer drains a direct pool to one backend', async () => {
    const db = await scratchDatabase(direct!, direct!);
    try {
      await withConsumer(db.url, async () => {
        const backends = async () => Number((await db.admin.unsafe(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [db.name]))[0]!.n);
        expect(await backends()).toBeGreaterThanOrEqual(3);
        await Bun.sleep(IDLE_DRAIN_MS);
        expect(await backends()).toBe(1);
      });
    } finally { await db.drop(); }
  }, 120_000);

  test('a write from another process is published within the idle cap; a same-process wake is immediate', async () => {
    const db = await scratchDatabase(direct!, direct!);
    try {
      await withConsumer(db.url, async (engine, consumer, config) => {
        const sources = await fixtures(engine, config);
        const other = new PostgresEngine();
        await other.connect({ database_url: db.url, poolSize: 2 });
        try {
          await Bun.sleep(12_000);
          let started = performance.now();
          const remote = await admitWrite(other, admission(config, sources[0], 'idle/cross-process', 'remote body'));
          await waitFor(async () => (await getWriteRequestById(other, remote.id))?.state === 'committed', { timeoutMs: 10_000 });
          expect(performance.now() - started).toBeLessThan(5_000 + 3_000);
          await Bun.sleep(12_000);
          started = performance.now();
          const local = await admitWrite(engine, admission(config, sources[0], 'idle/same-process', 'local body'));
          consumer.wake();
          await waitFor(async () => (await getWriteRequestById(engine, local.id))?.state === 'committed', { timeoutMs: 10_000 });
          expect(performance.now() - started).toBeLessThan(3_000);
        } finally { await other.disconnect(); }
      });
    } finally { await db.drop(); }
  }, 120_000);
});

describe.skipIf(!direct)('#5233 / #6317 idle lane with a direct/session route configured', () => {
  // #6317 (reporter ask 2 on #6278): with a direct/session route configured the consumer's own statements take it, so an
  // idle consumer's probes run on the direct pool and the ordinary (pooler) connections all drain; before #6317 (#5233)
  // the idle probe reserved an ordinary-pool connection and opened no direct one.
  test('an idle consumer probes on the direct route and lets every ordinary-pool connection drain', async () => {
    const db = await scratchDatabase(direct!, direct!);
    const directRoute = new URL(db.url);
    directRoute.searchParams.set('application_name', 'gbrain_5233_direct_route');
    try {
      await withEnv({ GBRAIN_DIRECT_DATABASE_URL: directRoute.toString() }, () => withConsumer(db.url, async (engine, consumer) => {
        expect(engine.connectionManager?.isDualPoolActive()).toBe(true);
        expect(consumer.status().connection).toMatchObject({ lane: 'direct' });
        await Bun.sleep(IDLE_DRAIN_MS);
        const rows = await db.admin.unsafe<{ direct: number; total: number }[]>(`SELECT
          count(*) FILTER (WHERE application_name = 'gbrain_5233_direct_route')::int AS direct, count(*)::int AS total
          FROM pg_stat_activity WHERE datname = $1`, [db.name]);
        expect(rows[0]!.direct).toBeGreaterThanOrEqual(1);
        expect(rows[0]!.total - rows[0]!.direct).toBe(0);
        expect(engine.getPoolDiagnostics()?.tracked.reserved ?? 0).toBe(0);
      }));
    } finally { await db.drop(); }
  }, 120_000);

  test('a partly busy pool skips the idle reservation and still publishes writes', async () => {
    const db = await scratchDatabase(direct!, direct!);
    try {
      await withConsumer(db.url, async (engine, consumer, config) => {
        const sources = await fixtures(engine, config);
        const release = Promise.withResolvers<void>();
        let held = 0;
        const holding = Array.from({ length: 2 }, () => engine.transaction(async tx => {
          await tx.executeRaw('SELECT 1'); held++; await release.promise;
        }));
        try {
          await waitFor(() => held === 2);
          await consumer.tick();
          const write = await admitWrite(engine, admission(config, sources[0], 'idle/busy-pool', 'busy body'));
          consumer.wake();
          await waitFor(async () => (await getWriteRequestById(engine, write.id))?.state === 'committed', { timeoutMs: 10_000 });
          expect(engine.getPoolDiagnostics()?.tracked.reserved).toBe(0);
        } finally { release.resolve(); await Promise.all(holding); }
      });
    } finally { await db.drop(); }
  }, 120_000);
});

describe.skipIf(!(pooled && pooledAdmin) || !existsSync('/proc/self/net/tcp'))('idle persistence consumer behind transaction-mode PgBouncer', () => {
  test('an idle consumer drains its pooler client pool to one connection without LISTEN', async () => {
    const db = await scratchDatabase(pooledAdmin!, pooled!);
    const target = new URL(pooled!);
    const port = Number(target.port || 5432);
    try {
      await withConsumer(db.url, async () => {
        expect(await ownSockets(target.hostname, port)).toBeGreaterThanOrEqual(3);
        await Bun.sleep(IDLE_DRAIN_MS);
        expect(await ownSockets(target.hostname, port)).toBe(1);
      });
    } finally { await db.drop(); }
  }, 120_000);
});
