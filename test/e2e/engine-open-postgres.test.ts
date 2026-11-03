/**
 * openEngine(settings) on Postgres (Wave B1): each engine opened from settings gets its own pool of the size its
 * settings name, connects only to its own database and direct URL, and records its host identity as given, while
 * GBRAIN_DATABASE_URL, GBRAIN_DIRECT_DATABASE_URL, GBRAIN_POOL_SIZE, HOME and GBRAIN_HOME point elsewhere.
 * Each case uses scratch databases on the DATABASE_URL server. Skips without DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { withEnv } from '../helpers/with-env.ts';
import { hostIdFor, openEngine, type EngineSettings } from '../../src/core/engine-open.ts';
import { createEngine } from '../../src/core/engine-factory.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { startConsumerHeartbeat } from '../../src/core/persistence/consumer-heartbeat.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { EngineConfig } from '../../src/core/types.ts';
import { sharedParameterTypes, type SharedParameterTypes } from '../../src/core/pg-type-cache.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) console.log('Skipping E2E openEngine on Postgres (DATABASE_URL not set)');

const scratch = mkdtempSync(join(tmpdir(), 'gbrain-engine-open-pg-'));
const drops: Array<() => Promise<void>> = [];
const urls: string[] = [];
const dir = (name: string) => { const path = join(scratch, `${name}-${randomUUID().slice(0, 8)}`); mkdirSync(path, { recursive: true }); return path; };
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => !entry.isDirectory())
    .map(entry => relative(root, join(entry.parentPath, entry.name))).sort();
}
const writerValue = () => ({ id: randomUUID(), credential: randomBytes(32).toString('hex'), lane: 'stdio' as const });
const hostCtx = (engine: BrainEngine): OperationContext => ({
  engine, config: {}, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: true,
} as unknown as OperationContext);
const codeOf = async (work: Promise<unknown>) => { try { await work; return 'resolved'; } catch (error) { return (error as { code?: string }).code ?? String(error); } };
const internals = (engine: BrainEngine) => engine as unknown as { _sql: { options: { max: number } } | null; _connectionStyle: string | null;
  connectionManager: { resolveDirectUrl(): string | null } | null };
const CANARY_URL = 'postgresql://canary:canary@canary-example.invalid:5432/canary';
const CANARY_DIRECT = 'postgresql://canary:canary@canary-example.invalid:5432/canary-direct';

beforeAll(async () => {
  if (!DATABASE_URL) return;
  assertSafeE2eDatabaseUrl(DATABASE_URL);
  const admin = postgres(DATABASE_URL, { max: 1, prepare: false });
  for (let i = 0; i < 2; i++) {
    const name = `gbrain_test_engine_open_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(DATABASE_URL);
    url.pathname = `/${name}`;
    urls.push(url.toString());
    drops.push(async () => { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); });
  }
  drops.push(() => admin.end());
}, 60_000);

afterAll(async () => {
  for (const drop of drops) await drop().catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
});

describeE2E('openEngine on Postgres', () => {
  const settingsA: Partial<EngineSettings> = {};
  const settingsB: Partial<EngineSettings> = {};

  test('two engines keep their own database, pool, direct URL and host identity; ambient settings never redirect a write', async () => {
    const home = dir('canary-home');
    const gbrainHome = dir('clean-gbrain-home');
    const directB = urls[1]!;
    Object.assign(settingsA, { embedded_core: true, engine: 'postgres', database: { url: urls[0]! }, pool: { max: 2 }, host: { id: randomUUID() }, writer: writerValue() });
    Object.assign(settingsB, { embedded_core: true, engine: 'postgres', database: { url: urls[1]!, directUrl: directB }, pool: { max: 3 }, host: { id: randomUUID() }, writer: writerValue() });
    await withEnv({ HOME: home, GBRAIN_HOME: gbrainHome, GBRAIN_DATABASE_URL: CANARY_URL, GBRAIN_DIRECT_DATABASE_URL: CANARY_DIRECT, GBRAIN_POOL_SIZE: '1' }, async () => {
      const a = await openEngine(settingsA as EngineSettings);
      const b = await openEngine(settingsB as EngineSettings);
      try {
        await a.initSchema();
        await b.initSchema();
        expect(internals(a)._connectionStyle).toBe('instance');
        expect(internals(b)._connectionStyle).toBe('instance');
        expect(internals(a)._sql?.options.max).toBe(2);
        expect(internals(b)._sql?.options.max).toBe(3);
        expect(internals(a).connectionManager?.resolveDirectUrl()).not.toBe(CANARY_DIRECT);
        expect(internals(b).connectionManager?.resolveDirectUrl()).toBe(directB);
        expect(hostIdFor(a)).toBe(settingsA.host!.id);
        expect(hostIdFor(b)).toBe(settingsB.host!.id);
        // The statement-description cache stays in this process: no file under the home is read or written for it.
        expect((sharedParameterTypes(urls[0]) as SharedParameterTypes).file).toBeNull();
        expect((sharedParameterTypes(urls[1]) as SharedParameterTypes).file).toBeNull();
        await operationsByName.put_page.handler(hostCtx(a), { slug: 'notes/only-in-a', content: '---\ntitle: Only in A\n---\nWritten to database A.\n' });
        await operationsByName.put_page.handler(hostCtx(b), { slug: 'notes/only-in-b', content: '---\ntitle: Only in B\n---\nWritten to database B.\n' });
        expect((await a.getPage('notes/only-in-a'))?.compiled_truth).toContain('database A');
        expect(await a.getPage('notes/only-in-b')).toBeNull();
        expect((await b.getPage('notes/only-in-b'))?.compiled_truth).toContain('database B');
        expect(await b.getPage('notes/only-in-a')).toBeNull();
        const admitted = await a.executeRaw<{ admitter_host_id: string | null }>("SELECT admitter_host_id::text AS admitter_host_id FROM persistence_requests WHERE slug='notes/only-in-a'");
        expect(admitted.map(row => row.admitter_host_id)).toEqual([settingsA.host!.id]);
      } finally {
        await Promise.all([a.disconnect(), b.disconnect()]);
      }
      const reopened = await openEngine({ ...settingsA, writer: { ...settingsA.writer! } } as EngineSettings);
      try {
        expect((await reopened.getPage('notes/only-in-a'))?.compiled_truth).toContain('database A');
      } finally {
        await reopened.disconnect();
      }
    });
    // The connection-events audit log (connection-audit.ts) is a process-wide diagnostic sink, not an engine setting;
    // nothing else, and no host.json or writer credential, lands under the home.
    expect(filesUnder(gbrainHome).filter(path => !/^\.gbrain\/audit\/connection-events-\d{4}-W\d{2}\.jsonl$/.test(path))).toEqual([]);
    expect(filesUnder(home)).toEqual([]);
  }, 300_000);

  test('the consumer heartbeat records the identity-given-at-open sentinel, not a host.json path', async () => {
    const engine = await openEngine(settingsA as EngineSettings);
    try {
      const hostId = hostIdFor(engine);
      const heartbeat = startConsumerHeartbeat(engine, hostId, { kind: 'cli', mode: 'full', everyMs: 60_000,
        report: () => ({ restart_required: false, root_barrier_age_ms: null, pool: null }) });
      try {
        await heartbeat.renew();
        const rows = await engine.executeRaw<{ host_json_path: string; persistence_home: string; minted_under: unknown }>(
          'SELECT host_json_path, persistence_home, minted_under FROM persistence_consumers WHERE host_id=$1::uuid', [hostId]);
        expect(rows).toEqual([{ host_json_path: `embedded:${hostId}`, persistence_home: 'embedded', minted_under: null }]);
      } finally {
        await heartbeat.stop();
      }
    } finally {
      await engine.disconnect();
    }
  }, 120_000);

  test('initSchema refuses an existing database whose embedding width differs from settings.embedding', async () => {
    const engine = await openEngine({ ...settingsA, embedding: { model: 'voyage:voyage-4', dimensions: 768 } } as EngineSettings);
    try {
      expect(await codeOf(engine.initSchema())).toBe('engine_embedding_mismatch');
    } finally {
      await engine.disconnect();
    }
  }, 120_000);

  test('an unmarked engine keeps its instance pool, the ambient direct URL and the file identity (back-compat)', async () => {
    const gbrainHome = dir('unmarked-home');
    await withEnv({ GBRAIN_HOME: gbrainHome, GBRAIN_DIRECT_DATABASE_URL: CANARY_DIRECT, GBRAIN_POOL_SIZE: '1' }, async () => {
      const config: EngineConfig = { engine: 'postgres', database_url: urls[0]! };
      const engine = await createEngine(config);
      await engine.connect({ ...config, poolSize: 3 } as EngineConfig & { poolSize: number });
      try {
        expect(internals(engine)._sql?.options.max).toBe(3);
        expect(internals(engine).connectionManager?.resolveDirectUrl()).toBe(CANARY_DIRECT);
        expect(hostIdFor(engine)).toBe(localHostId());
        expect((sharedParameterTypes(urls[0]) as SharedParameterTypes).file?.startsWith(gbrainHome)).toBe(true);
      } finally {
        await engine.disconnect();
      }
    });
  }, 120_000);
});
