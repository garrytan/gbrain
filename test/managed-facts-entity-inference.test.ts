/**
 * #5836 — managed (coordinator) extract_facts: an inferred subject publishes
 * through publishManagedFacts with its context note in the fence cell and the
 * row, and a similar fact on the same entity is kept rather than deduped,
 * while exact text still dedups. PGLite, synthetic names only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { operationsByName } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

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

function chatStub(facts: Array<{ fact: string; entity: string | null }>) {
  __setChatTransportForTests(async () => ({ text: JSON.stringify({ facts: facts.map(f => ({ ...f, kind: 'fact', confidence: 1, notability: 'high' })) }),
    blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' }));
}

test('managed extract_facts links an inferred subject with its note and keeps a similar fact', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-infer-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'A registered entity.' }, { sourceId: 'default' });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array(1536).fill(0.01)) })) as never);
      const ctx = { engine, config: { engine: 'pglite' as const }, remote: false, sourceId: 'default', dryRun: false, logger: console };
      const extract = (fact: string, entity: string | null) => {
        chatStub([{ fact, entity }]);
        return operationsByName.extract_facts.handler(ctx, { turn_text: `A synthetic turn about ${fact}`, request_id: randomUUID(), visibility: 'world' }) as Promise<{ inserted: number; duplicate: number; fact_ids: number[] }>;
      };
      const explicit = await extract('Acme Example targets 40 percent gross margin', 'companies/acme-example');
      expect(explicit.inserted).toBe(1);
      const inferred = await extract('Acme Example targets 45 percent gross margin', null);
      expect(inferred).toMatchObject({ inserted: 1, duplicate: 0 });
      const facts = await engine.executeRaw<{ id: number; fact: string; entity_slug: string | null; context: string | null; expired_at: Date | null; row_num: number | null }>(
        'SELECT id,fact,entity_slug,context,expired_at,row_num FROM facts WHERE id=ANY($1::int[]) ORDER BY id', [[...explicit.fact_ids, ...inferred.fact_ids]]);
      expect(facts.map(f => [f.entity_slug, f.expired_at])).toEqual([['companies/acme-example', null], ['companies/acme-example', null]]);
      expect(facts[1].context).toBe('entity inferred from mention');
      expect(facts[1].row_num).not.toBeNull();
      const fence = parseFactsFence((await engine.getPage('companies/acme-example', { sourceId: 'default' }))!.compiled_truth).facts;
      expect(fence.find(f => f.claim === 'Acme Example targets 45 percent gross margin')?.context).toBe('entity inferred from mention');
      expect(fence.every(f => f.active)).toBe(true);
      const exact = await extract('Acme Example targets 45 percent gross margin', null);
      expect(exact).toMatchObject({ inserted: 0, duplicate: 1 });
      expect((await runExtractFacts(engine, { sourceId: 'default' })).legacyRowsPending).toBe(0);
    });
  } finally { await disposePersistenceConsumer(engine); rmSync(home, { recursive: true, force: true }); }
}, 60_000);
