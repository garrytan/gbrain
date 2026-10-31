/**
 * #7699: gbrain mcp verify's memory-writer fixture saves, reads back and
 * withdraws its fact on a brain that already holds a similarly named entity
 * page (same leading token, close title), and never touches that page.
 * The peer dispatches the real recall/remember/forget handlers as a remote
 * caller on PGLite. Synthetic names only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { verifyHarnessConnection, type VerificationPeer } from '../src/core/harness/verify.ts';
import type { HarnessCredentials } from '../src/core/harness/credentials.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';

let engine: PGLiteEngine;
const sourceId = 'source-a';
const NEAR = 'concepts/gbrain-verification';
const credentials: HarnessCredentials = { version: 1, client_id: 'gbrain_cl_verify_7699', mcp_url: 'https://brain.example.com/mcp',
  issuer_url: 'https://brain.example.com', access_token: 'fixture-token', source_id: sourceId, profile: 'memory-writer' };
const remoteCtx = { remote: true, sourceId, config: { engine: 'pglite' }, dryRun: false,
  auth: { clientId: credentials.client_id, scopes: ['read', 'write'], sourceId }, logger: { info() {}, warn() {}, error() {} } };

const nearPage = () => engine.executeRaw<{ compiled_truth: string; updated_at: string }>(
  'SELECT compiled_truth, updated_at::text FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, NEAR]);

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await registerLocalWriter(engine, 'cli'); await registerLocalWriter(engine, 'stdio');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () =>
    tx.putPage(NEAR, { type: 'concept', title: 'GBrain verification', compiled_truth: '# GBrain verification\n\nHow connections are checked.', frontmatter: {} }, { sourceId }),
    TEST_WRITE_ATTRIBUTION));
}, 60_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  resetGateway();
});

test('the memory-writer stages pass beside a near-named entity page, which stays untouched', async () => {
  const before = await nearPage();
  const calls: Array<{ name: string; error?: string }> = [];
  const peer: VerificationPeer = {
    connect: async () => {}, close: async () => {},
    readCapabilities: async () => ({ transport: 'oauth', client_id: credentials.client_id, scopes: ['read', 'write'], source_id: sourceId }),
    call: async (name, params) => {
      try { return await operationsByName[name]!.handler({ ...remoteCtx, engine } as unknown as OperationContext, params); }
      catch (e) { calls.push({ name, error: (e as Error).message }); throw e; }
    },
  };
  const report = await verifyHarnessConnection(credentials, { peer, timeoutMs: 30_000 });
  expect(calls).toEqual([]);
  expect(report.stages.filter(s => s.status === 'failed')).toEqual([]);
  expect(report.stages.find(s => s.name === 'write')?.status).toBe('passed');
  expect(report.stages.find(s => s.name === 'write_readback')?.status).toBe('passed');
  expect(report.stages.find(s => s.name === 'cleanup')?.status).toBe('passed');
  expect(await nearPage()).toEqual(before);
  const active = await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL', [sourceId, report.fixture]);
  expect(active).toEqual([]);
  expect(await engine.executeRaw('SELECT entity_slug FROM facts WHERE source_id=$1 AND fact=$2', [sourceId, report.fixture]))
    .toEqual([{ entity_slug: `gbrain-verification/${report.fixture}` }]);
  expect(await engine.executeRaw('SELECT slug, deleted_at FROM pages WHERE source_id=$1 AND slug LIKE $2', [sourceId, 'gbrain-verification/%'])).toEqual([]);
}, 60_000);
