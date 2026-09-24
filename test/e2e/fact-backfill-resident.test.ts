import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { saveConfig, type GBrainConfig } from '../../src/core/config.ts';
import { createPersistenceIpcProvider } from '../../src/core/persistence/provider.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { readLocalWriter, registerLocalWriter, revokeLocalWriter, type LocalRegistration, type LocalGrant } from '../../src/core/persistence/identity.ts';
import { startPersistenceIpcServer, requestPersistenceAdministration, requestPersistenceCapabilities, persistenceSocketPathForConfig, type PersistenceIpcBinding } from '../../src/core/persistence/ipc.ts';
import { withEnv } from '../helpers/with-env.ts';

const sourceId = 'resident-facts-example';
const foreignSource = 'resident-facts-foreign';
let root: string;
let engine: PGLiteEngine;
let binding: PersistenceIpcBinding;
let registration: LocalRegistration;
let brainId: string;
let calls: number;
let selectedConfig: GBrainConfig;
const inHome = <T>(run: () => Promise<T>) => withEnv({
  GBRAIN_HOME: root, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined,
  DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
}, run);
const config = () => ({ engine: 'pglite' as const, database_path: join(root, 'db'), embedding_disabled: false });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-facts-resident-'));
  await inHome(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: {} });
    engine = new PGLiteEngine();
    await engine.connect({ database_path: config().database_path });
    await engine.initSchema();
    for (const id of [sourceId, foreignSource]) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
  });
});

beforeEach(async () => inHome(async () => {
  saveConfig(config());
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test-key' } });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('DELETE FROM facts');
  await engine.setConfig('embedding_model', 'openai:text-embedding-3-small');
  await engine.setConfig('embedding_dimensions', '1536');
  await engine.setConfig('embedding_disabled', 'false');
  for (const [claim, source] of [['one', sourceId], ['two', sourceId], ['foreign', foreignSource]]) {
    await engine.insertFact({ fact: claim, source: 'notes', visibility: 'private', kind: 'fact', confidence: 1 }, { source_id: source });
  }
  registration = await registerLocalWriter(engine, 'cli', undefined, true);
  selectedConfig = config();
  const provider = await createPersistenceIpcProvider(engine, selectedConfig);
  brainId = provider.brainId;
  binding = (await startPersistenceIpcServer(persistenceSocketPathForConfig(config())!, provider))!;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  calls = 0;
  __setEmbedTransportForTests(async ({ values }) => {
    calls++;
    return { values, usage: { tokens: values.length }, warnings: [], embeddings: values.map(() => Array(1536).fill(0.25)) };
  });
}));

afterEach(async () => inHome(async () => {
  const closed = once(binding.server, 'close');
  binding.close();
  await closed;
  await disposePersistenceConsumer(engine);
  __setEmbedTransportForTests(null);
  resetGateway();
}));

afterAll(async () => {
  await inHome(() => engine.disconnect());
  rmSync(root, { recursive: true, force: true });
});

const request = (options: Record<string, unknown>, credentials = registration) => requestPersistenceAdministration(binding.socketPath, {
  version: 1, kind: 'administration', brain_id: brainId, operation: 'writer_embed_facts',
  params: { options }, registration: credentials,
});

const countEmbedded = async () => Number((await engine.executeRaw<{ count: string }>('SELECT count(*)::text AS count FROM facts WHERE embedding IS NOT NULL'))[0].count);

describe('resident managed fact-vector repair', () => {
  test('resident selected off-switch cannot be enabled by host or caller configuration', () => inHome(async () => {
    selectedConfig.embedding_disabled = true;
    await expect(request({ sourceId, yes: true, maxCostUsd: 1 })).rejects.toThrow('no-embedding');
    await expect(request({ sourceId, yes: true, maxCostUsd: 1, config: { embedding_disabled: false } })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(requestPersistenceAdministration(binding.socketPath, {
      version: 1, kind: 'administration', brain_id: brainId, operation: 'writer_embed_facts',
      params: { options: { sourceId, yes: true, maxCostUsd: 1 }, config: { embedding_disabled: false } }, registration,
    })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(await request({ sourceId, dryRun: true })).toMatchObject({ dryRun: true, would_embed: 2 });
    expect(calls).toBe(0);
    expect(await countEmbedded()).toBe(0);
  }));

  test('authenticated preview and bounded execution work without canonical mutations', () => inHome(async () => {
    const canonical = async () => Array.from(await engine.executeRaw("SELECT to_jsonb(f)-ARRAY['embedding','embedded_at'] AS row FROM facts f ORDER BY id"));
    const before = await canonical();
    expect(await request({ sourceId })).toMatchObject({ dryRun: true, would_embed: 2, embedded: 0 });
    expect(calls).toBe(0);
    expect(await request({ sourceId, yes: true, maxCostUsd: 1, maxFacts: 1 })).toMatchObject({ embedded: 1, remaining: 1, failures: 0 });
    expect(await request({ sourceId, yes: true, maxCostUsd: 1 })).toMatchObject({ embedded: 1, remaining: 0, failures: 0 });
    expect(await request({ sourceId, yes: true, maxCostUsd: 1 })).toMatchObject({ embedded: 0, remaining: 0, failures: 0 });
    expect(await canonical()).toEqual(before);
    expect(await countEmbedded()).toBe(2);
    expect(calls).toBe(2);
    await expect(engine.executeRaw("UPDATE facts SET visibility='world' WHERE source_id=$1", [sourceId])).rejects.toThrow('writer_coordinator_required');
  }));

  test('the private operation is absent from public operations and rejects stdio or forged consent', () => inHome(async () => {
    const capabilities = await requestPersistenceCapabilities(binding.socketPath);
    expect(capabilities.administration).toContain('writer_embed_facts');
    expect(capabilities.operations).not.toContain('writer_embed_facts');
    const stdio = await readLocalWriter(engine, 'stdio');
    await expect(request({ sourceId }, stdio)).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(request({ sourceId }, { ...stdio, lane: 'cli' })).rejects.toMatchObject({ code: 'permission_denied' });
    for (const options of [
      { sourceId, yes: 'true', maxCostUsd: 1 }, { sourceId, yes: true },
      { sourceId, yes: true, maxCostUsd: 1, remote: false }, { sourceId, yes: true, maxCostUsd: -1 },
    ]) await expect(request(options)).rejects.toMatchObject({ code: 'invalid_params' });
    expect(calls).toBe(0);
    expect(await countEmbedded()).toBe(0);
  }));

  test('source, operation, scope and slug ceilings are checked before spending', () => inHome(async () => {
    const grant: LocalGrant = { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null };
    for (const narrowed of [
      { ...grant, sourceIds: [foreignSource] }, { ...grant, operations: ['get_page'] },
      { ...grant, scopes: ['read'] }, { ...grant, slugPrefixes: ['people/*'] },
    ]) {
      registration = await registerLocalWriter(engine, 'cli', narrowed, true);
      await expect(request({ sourceId, yes: true, maxCostUsd: 1 })).rejects.toMatchObject({ code: 'permission_denied' });
    }
    expect(calls).toBe(0);
    expect(await countEmbedded()).toBe(0);
  }));

  test('revocation during provider work prevents vector installation', () => inHome(async () => {
    __setEmbedTransportForTests(async ({ values }) => {
      calls++;
      await revokeLocalWriter(engine, registration.id);
      return { values, usage: { tokens: 1 }, warnings: [], embeddings: values.map(() => Array(1536).fill(0.25)) };
    });
    expect(await request({ sourceId, yes: true, maxCostUsd: 1 })).toMatchObject({ embedded: 0, failures: 2, stopped: 'failed' });
    expect(await countEmbedded()).toBe(0);
    await expect(request({ sourceId })).rejects.toMatchObject({ code: 'permission_denied' });
    expect(calls).toBe(1);
  }));

  test('a mid-flight source grant narrowing prevents vector installation', () => inHome(async () => {
    __setEmbedTransportForTests(async ({ values }) => {
      await engine.executeRaw(`UPDATE persistence_local_writers SET grant_ceiling=grant_ceiling ||
        jsonb_build_object('sourceIds',ARRAY[$2]::text[]) WHERE id=$1::uuid`, [registration.id, foreignSource]);
      return { values, usage: { tokens: 1 }, warnings: [], embeddings: values.map(() => Array(1536).fill(0.25)) };
    });
    expect(await request({ sourceId, yes: true, maxCostUsd: 1 })).toMatchObject({ embedded: 0, failures: 2, stopped: 'failed' });
    expect(await countEmbedded()).toBe(0);
  }));

  test('the actual CLI delegates before opening the owner-held PGLite database', () => inHome(async () => {
    const run = async (extra: string[], expectedStatus = 0) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../../src/cli.ts'),
        'embed', '--stale', '--facts', '--source', sourceId, '--json', ...extra], {
        cwd: root, env: { ...process.env, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0' }, stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ status, stderr }).toMatchObject({ status: expectedStatus });
      return JSON.parse(stdout);
    };
    expect(await run([])).toMatchObject({ dryRun: true, would_embed: 2 });
    expect(calls).toBe(0);
    expect(await run(['--yes', '--max-cost-usd', '0'], 1)).toMatchObject({ embedded: 0, failures: 2, stopped: 'failed' });
    expect(calls).toBe(0);
    expect(await run(['--yes', '--max-cost-usd', '1', '--max-facts', '1'])).toMatchObject({ embedded: 1, remaining: 1 });
    expect(await run(['--yes', '--max-cost-usd', '1'])).toMatchObject({ embedded: 1, remaining: 0 });
    expect(await countEmbedded()).toBe(2);
    expect(calls).toBe(2);
  }));
});
