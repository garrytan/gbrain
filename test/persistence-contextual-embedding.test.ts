import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { operationsByName } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const cases = [
  { name: 'global title', source: null, expected: 'title' },
  { name: 'source none', source: 'none', expected: 'none' },
  { name: 'source title overrides conservative', source: 'title', global: 'conservative', expected: 'title' },
  { name: 'source synopsis retains existing free title fallback', source: 'per_chunk_synopsis', expected: 'title' },
  { name: 'trusted frontmatter none', source: 'title', frontmatter: 'none', trusted: true, expected: 'none' },
  { name: 'trusted synopsis retains existing free title fallback', source: 'none', frontmatter: 'per_chunk_synopsis', trusted: true, expected: 'title' },
  { name: 'untrusted frontmatter cannot override source', source: 'none', frontmatter: 'title', expected: 'none' },
  { name: 'kill switch overrides trusted frontmatter', source: 'title', frontmatter: 'title', trusted: true, disabled: true, expected: 'none' },
] as const;

for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`${kind}: coordinated deferred contextual embeddings`, () => {
    let engine: BrainEngine;
    const sources: string[] = [];
    let unexpectedProviderCalls = 0;
    beforeAll(async () => {
      engine = kind === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
      if (kind === 'postgres') assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
      await engine.connect(kind === 'postgres' ? { database_url: process.env.DATABASE_URL! } : {});
      await engine.initSchema();
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
        env: { OPENAI_API_KEY: 'synthetic-contextual-fixture' } });
      __setEmbedTransportForTests(async () => { unexpectedProviderCalls++; throw new Error('Provider called before deferred execution'); });
    }, 120_000);
    afterAll(async () => {
      await disposePersistenceConsumer(engine);
      try {
        await engine.executeRaw('DELETE FROM persistence_effects WHERE source_id=ANY($1::text[])', [sources]);
        await engine.executeRaw('DELETE FROM persistence_requests WHERE source_id=ANY($1::text[])', [sources]);
        await engine.executeRaw('DELETE FROM sources WHERE id=ANY($1::text[])', [sources]);
      } finally {
        await engine.disconnect();
        __setEmbedTransportForTests(null); resetGateway();
      }
    }, 60_000);

    function context(sourceId: string): OperationContext {
      return { engine, sourceId, config: { engine: kind, embedding_disabled: true }, remote: false, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } };
    }
    async function fixture(sourceMode: string | null, trusted = false) {
      const sourceId = `cr-${randomUUID().slice(0, 12)}`; sources.push(sourceId);
      await engine.executeRaw('INSERT INTO sources(id,name,contextual_retrieval_mode,trust_frontmatter_overrides) VALUES($1,$1,$2,$3)',
        [sourceId, sourceMode, trusted]);
      await engine.setConfig('search.mode', 'balanced');
      await engine.setConfig('search.contextual_retrieval_disabled', 'false');
      return sourceId;
    }
    async function publish(sourceId: string, title: string, frontmatter?: string, revision?: string) {
      const requestId = randomUUID();
      const content = `---\ntitle: ${title}\n${frontmatter ? `contextual_retrieval: ${frontmatter}\n` : ''}---\n\nStable public body.`;
      const receipt = await operationsByName.put_page.handler(context(sourceId), {
        slug: 'notes/context', request_id: requestId, content, ...(revision ? { expected_revision: revision } : {}),
      });
      expect(receipt).toMatchObject({ state: 'committed', request_id: requestId });
      await disposePersistenceConsumer(engine);
      const [row] = await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_requests WHERE request_id=$1::uuid AND source_id=$2', [requestId, sourceId]);
      return row.id;
    }
    async function runEmbedding(requestId: string, embed: (texts: string[]) => Promise<Float32Array[]>) {
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour'");
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE request_id=$1::uuid AND kind='embedding'", [requestId]);
      await runPersistenceEffects(engine, { engine: kind }, { hostId: localHostId(), limit: 1,
        embedding: { signature: 'fixture-contextual:1536', model: 'openai:text-embedding-3-large', embed } });
    }

    for (const option of cases) test(option.name, async () => {
      const sourceId = await fixture(option.source, 'trusted' in option && option.trusted);
      if ('global' in option) await engine.setConfig('search.mode', option.global);
      if ('disabled' in option) await engine.setConfig('search.contextual_retrieval_disabled', 'true');
      const requestId = await publish(sourceId, 'Context Fixture', 'frontmatter' in option ? option.frontmatter : undefined);
      const snapshot = (await engine.readPageSnapshot('notes/context', { sourceId }))!;
      expect(snapshot.page.contextual_retrieval_mode).toBe(option.expected);
      expect(snapshot.page.text_projection_revision).toBe(snapshot.revision);
      const [stamp] = await engine.executeRaw<{ corpus_generation: string | null; embedding_signature: string | null }>(
        'SELECT corpus_generation,embedding_signature FROM pages WHERE id=$1', [snapshot.page.id]);
      if (option.expected === 'title') expect(stamp.corpus_generation).toMatch(/^[0-9a-f]{16}$/);
      else expect(stamp.corpus_generation).toBeNull();
      expect(stamp.embedding_signature).toBeNull();
      expect(unexpectedProviderCalls).toBe(0);
      let calls = 0;
      await runEmbedding(requestId, async texts => {
        calls++;
        if (option.expected === 'title') expect(texts[0]).toContain('<context>Context Fixture');
        else expect(texts[0]).not.toContain('<context>');
        // A second engine transaction completes during provider execution:
        // the outbox holds no publication transaction across this call.
        await engine.transaction(tx => tx.executeRaw('SELECT 1'));
        return texts.map(() => new Float32Array(1536).fill(0.01));
      });
      expect(calls).toBe(1);
      const chunks = await engine.getChunks('notes/context', { sourceId });
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every(chunk => chunk.embedding_is_null === false)).toBe(true);
      expect(chunks.every(chunk => !chunk.chunk_text.includes('<context>'))).toBe(true);
      expect((await engine.readPageSnapshot('notes/context', { sourceId }))!.revision).toBe(snapshot.revision);
    });

    test('a transient source-policy read retries the same request instead of using global mode', async () => {
      const sourceId = await fixture('none');
      const original = engine.executeRaw;
      let policyReads = 0;
      engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
        if (sql.includes('SELECT id, name, local_path, last_commit') && params?.[0] === sourceId) {
          policyReads++;
          if (policyReads === 1) throw Object.assign(new Error('Synthetic source policy serialization failure'), { code: '40001' });
        }
        return original.call(this, sql, params);
      } as BrainEngine['executeRaw'];
      try {
        const requestId = await publish(sourceId, 'Source Policy');
        expect(policyReads).toBeGreaterThanOrEqual(2);
        expect((await engine.readPageSnapshot('notes/context', { sourceId }))!.page.contextual_retrieval_mode).toBe('none');
        const rows = await engine.executeRaw<{ id: string; state: string }>('SELECT id,state FROM persistence_requests WHERE source_id=$1', [sourceId]);
        expect(rows).toEqual([{ id: requestId, state: 'committed' }]);
        expect(unexpectedProviderCalls).toBe(0);
      } finally { await disposePersistenceConsumer(engine); engine.executeRaw = original; }
    });

    test('title replacement while provider is running rejects old wrapped vectors', async () => {
      const sourceId = await fixture('title');
      const requestId = await publish(sourceId, 'Original Title');
      const before = (await engine.readPageSnapshot('notes/context', { sourceId }))!;
      let calls = 0;
      await runEmbedding(requestId, async texts => {
        calls++; expect(texts[0]).toContain('<context>Original Title');
        await publish(sourceId, 'Replacement Title', undefined, before.revision);
        return texts.map(() => new Float32Array(1536).fill(0.25));
      });
      expect(calls).toBe(1);
      const current = (await engine.readPageSnapshot('notes/context', { sourceId }))!;
      expect(current.page.title).toBe('Replacement Title');
      expect(current.revision).not.toBe(before.revision);
      expect(current.page.contextual_retrieval_mode).toBe('title');
      const chunks = await engine.getChunks('notes/context', { sourceId });
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every(chunk => chunk.embedding_is_null === true)).toBe(true);
      expect(unexpectedProviderCalls).toBe(0);
    });
  });
}
