/**
 * A brain that opts out of embedding (embedding_disabled in the caller's or
 * the running consumer's config, or in the brain's DB plane) never sends fact
 * text to the embedding provider, even when a key sits in the environment.
 * Covers every fact write path that embeds: writeSingleFact (unmanaged and
 * managed), remember (prepared by the consumer) and turn extraction (the facts
 * backstop and conversation extraction). A fake embedder records every call.
 * PostgreSQL arm: test/e2e/fact-embedding-opt-out.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { operationsByName } from '../src/core/operations.ts';
import { configureGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { extractFactsFromTurnWithOutcome } from '../src/core/facts/extract.ts';
import { startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const ENTITY = 'people/opt-out-example';
const CLAIM = 'Opt Out Example prefers written agendas.';
let embedded: string[] = [];

beforeEach(() => {
  embedded = [];
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { OPENAI_API_KEY: 'fixture-key', ANTHROPIC_API_KEY: 'fixture-key' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    embedded.push(...values);
    return { embeddings: values.map(() => [1, ...Array(LEGACY_EMBEDDING_CONFIG.embedding_dimensions - 1).fill(0)]) };
  }) as never);
  __setChatTransportForTests(async () => ({
    text: JSON.stringify({ facts: [{ fact: CLAIM, kind: 'preference', entity: ENTITY, confidence: 1, notability: 'high' }] }),
    blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test',
  }) as never);
});
afterEach(() => { __setEmbedTransportForTests(null); __setChatTransportForTests(null); });

async function seedEntity(engine: BrainEngine, root: string): Promise<void> {
  const person = await engine.putPage(ENTITY, { type: 'person', title: 'Opt Out Example', compiled_truth: '# Opt Out Example' }, { sourceId: 'default' });
  await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2', [`${ENTITY}.md`, person.id]);
  const snapshot = (await engine.readPageSnapshot(ENTITY, { sourceId: 'default' }))!;
  mkdirSync(join(root, 'people'), { recursive: true });
  writeFileSync(join(root, `${ENTITY}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`fact writes on a brain that opted out of embedding send nothing to the provider (${backend})`, () => {
    // Unmanaged brain shared by the unmanaged cases; each case sets the embedding_disabled row it needs.
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (databaseUrl) {
        ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
      await engine.putPage(ENTITY, { type: 'person', title: 'Opt Out Example', compiled_truth: '# Opt Out Example' });
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('unmanaged writeSingleFact with embedding_disabled on the brain', async () => {
      await engine.setConfig('embedding_disabled', 'true');
      const written = await writeSingleFact(engine, 'default', { fact: CLAIM, provenance: 'fixture', entity: ENTITY, kind: 'preference' });
      expect(written).toMatchObject({ status: 'inserted', degraded_dedup: true });
      expect(embedded).toEqual([]);
      await engine.setConfig('embedding_disabled', 'false');
      await writeSingleFact(engine, 'default', { fact: 'Opt Out Example books rooms early.', provenance: 'fixture', entity: ENTITY, kind: 'preference' });
      expect(embedded).toEqual(['Opt Out Example books rooms early.']);
    }, 120_000);

    test('managed writeSingleFact and remember under a keyless consumer', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        expect(ctx.config.embedding_disabled).toBe(true);
        startPersistenceConsumer(engine, ctx.config);
        const written = await writeSingleFact(engine, 'default', { fact: CLAIM, provenance: 'fixture', entity: ENTITY, kind: 'preference' });
        expect(written).toMatchObject({ status: 'inserted', entity_slug: ENTITY });
        const remembered = await operationsByName.remember!.handler(ctx, { fact: 'Opt Out Example reviews notes on Fridays.', provenance: 'fixture',
          entity: ENTITY, request_id: randomUUID() }) as Record<string, unknown>;
        expect(remembered).toMatchObject({ state: 'committed', degraded_dedup: true });
        expect(embedded).toEqual([]);
        expect(await engine.executeRaw('SELECT id FROM facts WHERE embedding IS NOT NULL')).toEqual([]);
      }, { databaseUrl, setup: ({ engine, root }) => seedEntity(engine, root) });
    }, 180_000);

    test('turn extraction (facts backstop, conversation extraction) with embedding_disabled on the brain', async () => {
      await engine.setConfig('embedding_disabled', 'true');
      const outcome = await extractFactsFromTurnWithOutcome({ turnText: `${CLAIM} They said so in the planning chat.`, source: 'test', engine });
      expect(outcome).toMatchObject({ ok: true });
      expect(outcome.ok && outcome.facts.map(f => [f.fact, f.embedding ?? null])).toEqual([[CLAIM, null]]);
      expect(embedded).toEqual([]);
    }, 120_000);
  });
}
