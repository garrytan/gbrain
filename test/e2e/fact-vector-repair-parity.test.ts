import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const databaseUrl = process.env.DATABASE_URL;
const slug = 'people/vector-repair-example';

for (const kind of ['pglite', 'postgres'] as const) {
  describe.skipIf(kind === 'postgres' && !databaseUrl)(`${kind} fact-vector preservation`, () => {
    let engine: BrainEngine;
    let closePostgres: (() => Promise<void>) | undefined;
    const vector = new Float32Array(1536).fill(0.25);

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: {} });
      if (kind === 'postgres') {
        const fixture = await isolatedPersistencePostgres(databaseUrl!);
        engine = fixture.engine;
        closePostgres = fixture.close;
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
      }
    });

    beforeEach(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test-key' } });
      await engine.executeRaw('DELETE FROM facts WHERE source_markdown_slug=$1', [slug]);
      await engine.executeRaw('DELETE FROM pages WHERE slug=$1', [slug]);
      await setFence('Original claim', 2);
      await engine.insertFacts([{
        fact: 'Original claim', entity_slug: slug, source: 'notes', source_markdown_slug: slug,
        row_num: 1, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium',
        embedding: vector,
      }], { source_id: 'default' });
    });

    afterEach(() => {
      __setEmbedTransportForTests(null);
      resetGateway();
    });

    afterAll(async () => {
      await engine.executeRaw('DELETE FROM facts WHERE source_markdown_slug=$1', [slug]);
      await engine.executeRaw('DELETE FROM pages WHERE slug=$1', [slug]);
      if (closePostgres) await closePostgres();
      else await engine.disconnect();
    });

    async function setFence(claim: string, rowNum: number, visibility: 'world' | 'private' = 'world', active = true) {
      await engine.putPage(slug, {
        title: 'Vector repair example', type: 'person', timeline: '', frontmatter: {},
        compiled_truth: renderFactsTable([{
          rowNum, claim, kind: 'fact', confidence: 1, visibility,
          notability: 'medium', source: 'notes', active,
        }]),
      });
    }

    async function snapshot() {
      return Array.from(await engine.executeRaw<{ id: string; fact: string; embedding: string | null; row_num: number }>(
        'SELECT id::text, fact, embedding::text, row_num FROM facts WHERE source_markdown_slug=$1 ORDER BY id', [slug]));
    }

    test('provider failure preserves the existing rows and valid vectors', async () => {
      const before = await snapshot();
      __setEmbedTransportForTests(async () => { throw new Error('synthetic provider failure'); });
      const result = await runExtractFacts(engine, { slugs: [slug] });
      expect(await snapshot()).toEqual(before);
      expect(result.factsDeleted).toBe(0);
      expect(result.warnings.some(w => w.includes('reconciliation deferred'))).toBe(true);
    });

    test('abort during embedding cannot commit destructive replacement', async () => {
      const before = await snapshot();
      const controller = new AbortController();
      __setEmbedTransportForTests(async ({ values }) => {
        controller.abort();
        return { values, usage: { tokens: 1 }, warnings: [], embeddings: [Array(1536).fill(0.5)] };
      });
      const result = await runExtractFacts(engine, { slugs: [slug], signal: controller.signal });
      expect(await snapshot()).toEqual(before);
      expect(result.factsDeleted).toBe(0);
    });

    test('abort during database insertion rolls back the destructive transaction', async () => {
      const before = await snapshot();
      const controller = new AbortController();
      __setEmbedTransportForTests(async ({ values }) => ({
        values, usage: { tokens: 1 }, warnings: [], embeddings: [Array(1536).fill(0.5)],
      }));
      const original = engine.insertFacts;
      engine.insertFacts = async function (this: BrainEngine, ...args) {
        const inserted = await original.apply(this, args);
        controller.abort();
        return inserted;
      };
      try {
        const result = await runExtractFacts(engine, { slugs: [slug], signal: controller.signal });
        expect(await snapshot()).toEqual(before);
        expect(result.factsDeleted).toBe(0);
      } finally {
        engine.insertFacts = original;
      }
    });

    test('unavailable provider does not erase previously valid vectors', async () => {
      const before = await snapshot();
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: {} });
      await runExtractFacts(engine, { slugs: [slug] });
      expect(await snapshot()).toEqual(before);
    });

    test('changed text receives a new vector rather than reusing the old one', async () => {
      await setFence('Changed claim', 1);
      __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
        expect(values).toEqual(['Changed claim']);
        return { values, usage: { tokens: 1 }, warnings: [], embeddings: [Array(1536).fill(0.5)] };
      });
      const result = await runExtractFacts(engine, { slugs: [slug] });
      const rows = await snapshot();
      expect(result.factsInserted).toBe(1);
      expect(rows[0].fact).toBe('Changed claim');
      expect(JSON.parse(rows[0].embedding!)[0]).toBe(0.5);
    });

    test('failed embedding cannot retain a removed claim as active or reuse its vector for changed text', async () => {
      await setFence('Changed claim', 1);
      const before = await snapshot();
      __setEmbedTransportForTests(async () => { throw new Error('synthetic provider failure'); });
      await runExtractFacts(engine, { slugs: [slug] });
      expect(await snapshot()).toEqual(before);
      const active = await engine.executeRaw('SELECT id FROM facts WHERE source_markdown_slug=$1 AND expired_at IS NULL', [slug]);
      expect(active).toHaveLength(0);
    });

    test('privacy tightening survives failed embedding without discarding the valid vector', async () => {
      await setFence('Original claim', 1, 'private');
      const before = await snapshot();
      __setEmbedTransportForTests(async () => { throw new Error('synthetic provider failure'); });
      await runExtractFacts(engine, { slugs: [slug] });
      expect(await snapshot()).toEqual(before);
      const [row] = await engine.executeRaw<{ visibility: string }>('SELECT visibility FROM facts WHERE source_markdown_slug=$1', [slug]);
      expect(row.visibility).toBe('private');
    });

    test('withdrawal in the fence remains inactive when embedding fails', async () => {
      await setFence('Original claim', 1, 'world', false);
      __setEmbedTransportForTests(async () => { throw new Error('synthetic provider failure'); });
      await runExtractFacts(engine, { slugs: [slug] });
      const active = await engine.executeRaw('SELECT id FROM facts WHERE source_markdown_slug=$1 AND expired_at IS NULL', [slug]);
      expect(active).toHaveLength(0);
      expect((await snapshot())[0].embedding).not.toBeNull();
    });

    test('a keyless first insert remains supported', async () => {
      await engine.executeRaw('DELETE FROM facts WHERE source_markdown_slug=$1', [slug]);
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: {} });
      const result = await runExtractFacts(engine, { slugs: [slug] });
      expect(result.factsInserted).toBe(1);
      expect((await snapshot())[0]).toMatchObject({ fact: 'Original claim', embedding: null });
    });
  });
}
