import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { operationsByName } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { factContractCases, exerciseManagedFacts } from './helpers/managed-facts-contract.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
  await engine.setConfig('embedding_dimensions', '1536');
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
});
afterEach(() => { __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway(); });
afterAll(async () => { await engine.disconnect(); });

for (const scenario of factContractCases) test(`managed facts ${scenario}`, () => exerciseManagedFacts(engine, scenario), 60_000);

test('omitted extraction request IDs create distinct writes and returned IDs recover the original outcome', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-facts-request-id-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      let calls = 0;
      __setChatTransportForTests(async () => {
        calls++;
        return { text: '{"facts":[]}', blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' };
      });
      const ctx = { engine, config: { engine: 'pglite' as const, embedding_disabled: true }, remote: false, sourceId: 'default', dryRun: false, logger: console };
      const params = { turn_text: 'A synthetic event happened today.' };
      const first = await operationsByName.extract_facts.handler(ctx, params) as { write_requests: Array<{ request_id: string }> };
      const second = await operationsByName.extract_facts.handler(ctx, params) as { write_requests: Array<{ request_id: string }> };
      expect(calls).toBe(2);
      expect(first.write_requests).toHaveLength(1);
      expect(second.write_requests).toHaveLength(1);
      expect(first.write_requests[0].request_id).not.toBe(second.write_requests[0].request_id);
      const replay = await operationsByName.extract_facts.handler(ctx, { ...params, request_id: first.write_requests[0].request_id });
      expect(replay).toEqual(first);
      expect(calls).toBe(2);
      expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE operation='extract_facts'")).toHaveLength(2);
    });
  } finally { await disposePersistenceConsumer(engine); rmSync(home, { recursive: true, force: true }); }
}, 60_000);

test('legacy fact fence callers refuse managed work before falling back or touching files', async () => {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await expect(writeFactsToFence(engine, { sourceId: 'default', slug: 'people/example', localPath: null, resolutionSource: 'exact_page' }, [
    { fact: 'A synthetic fact.', kind: 'fact', source: 'fixture', visibility: 'private', notability: 'medium', embedding: null, sessionId: null },
  ])).rejects.toMatchObject({ code: 'writer_coordinator_required' });
  expect(await engine.executeRaw('SELECT id FROM facts')).toHaveLength(0);
});

test('managed extract_facts publishes multiple private entity fences and replays without provider calls', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-facts-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      for (const slug of ['people/alice-example', 'companies/acme-example']) await engine.putPage(slug,
        { type: slug.startsWith('people') ? 'person' : 'company', title: slug, compiled_truth: 'A registered entity.' }, { sourceId: 'default' });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      let calls = 0;
      __setChatTransportForTests(async () => { calls++; return { text: JSON.stringify({ facts: [
        { fact: 'Alice-example prefers weekly status reports.', kind: 'preference', entity: 'people/alice-example', confidence: 0.9, notability: 'high' },
        { fact: 'Acme-example measures monthly growth.', kind: 'fact', entity: 'companies/acme-example', confidence: 0.8, notability: 'medium' },
      ] }), blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' }; });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array(1536).fill(0.01)) })) as never);
      const ctx = { engine, config: { engine: 'pglite' as const }, remote: false, sourceId: 'default', dryRun: false, logger: console };
      const params = { turn_text: 'A meeting about the two registered entities and their operating preferences.', request_id: randomUUID() };
      const first = await operationsByName.extract_facts.handler(ctx, params) as { inserted: number; fact_ids: number[] };
      expect(first.inserted).toBe(2);
      expect(first.fact_ids).toHaveLength(2);
      for (const slug of ['people/alice-example', 'companies/acme-example']) expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toContain('## Facts');
      expect(await engine.executeRaw("SELECT id FROM facts WHERE visibility='private' AND embedding IS NOT NULL")).toHaveLength(2);
      const replay = await operationsByName.extract_facts.handler(ctx, params);
      expect(replay).toMatchObject({ inserted: 2, fact_ids: first.fact_ids });
      expect(calls).toBe(1);
    });
  } finally { await disposePersistenceConsumer(engine); rmSync(home, { recursive: true, force: true }); }
}, 60_000);
