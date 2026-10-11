import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { type EffectWorkerOptions, runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { embeddingInputContext, installPageEmbeddings, installPageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { embeddingInputHash, plainEmbeddingTier } from '../src/core/embedding-input-hash.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { digest, sha256 } from '../src/core/persistence/digest.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const databaseUrl = process.env.DATABASE_URL;
const model = 'ollama:embeddinggemma:latest';
const signature = `${model}:1536`;

for (const backend of testBackends()) {
  describe(`embedding persistence title proof ${backend}`, () => {
    let engine: BrainEngine;
    let scratch: string;
    let close: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-embedding-title-proof-'));
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(databaseUrl!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({ database_path: join(scratch, 'brain') });
        await engine.initSchema();
      }
      await engine.setConfig('embedding_model', model);
      await engine.setConfig('embedding_dimensions', '1536');
      configureGateway({ embedding_model: model, embedding_dimensions: 1536, env: {} });
    }, 120_000);

    afterAll(async () => {
      await engine?.disconnect();
      if (close) await close();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
      resetGateway();
    });

    async function fixture() {
      await registerLocalWriter(engine, 'cli');
      const sourceId = `embedding-title-${randomUUID()}`;
      const [source] = await engine.executeRaw<{ incarnation: string }>(
        'INSERT INTO sources(id,name) VALUES($1,$1) RETURNING incarnation', [sourceId]);
      const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId,
        logger: { info() {}, warn() {}, error() {} } };
      const authority = await submissionAuthority(ctx, 'put_page', sourceId, source.incarnation, 'page');
      const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
        sourceIncarnation: source.incarnation, slug: 'page', requestId: randomUUID(),
        callerIntent: { body: 'Current body' }, intent: { body: 'Current body' } });
      const row = (await claimNextWrite(engine, localHostId()))!;
      expect(row.id).toBe(admitted.id);
      await publishMutation(engine, row, { observedRevision: null, apply: async tx => {
        await tx.putPage('page', { type: 'note', title: 'Current title', compiled_truth: 'Current body', timeline: '', frontmatter: {} }, { sourceId });
        return {};
      } }, localHostId());
      const prepared = (await readProjectionSnapshot(engine, 'page', sourceId, { allowUnsealed: true }))!;
      await installPageProjection(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current body' }], { seal: true });
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour'");
      const [effect] = await engine.executeRaw<{ id: string }>(`UPDATE persistence_effects SET next_attempt_at=now()
        WHERE request_id=$1::uuid AND kind='embedding' RETURNING id`, [row.id]);
      return { sourceId, snapshot: prepared.snapshot, effectId: effect.id };
    }

    async function embed(effectId: string, callback: NonNullable<EffectWorkerOptions['embedding']>['embed']) {
      await runPersistenceEffects(engine, { engine: engine.kind }, {
        hostId: localHostId(), limit: 1, embedding: { signature, model, embed: callback },
      });
      return engine.executeRaw<{ state: string }>('SELECT state FROM persistence_effects WHERE id=$1', [effectId]);
    }

    test('null, legacy, and old-title proofs stay pending; the effect embeds and installs with the guarded title', async () => {
      for (const staleProof of ['null', 'legacy', 'old-title'] as const) {
        const f = await fixture();
        const prepared = (await readProjectionSnapshot(engine, 'page', f.sourceId))!;
        const vector = () => new Float32Array(1536).fill(0.25);
        expect(await installPageEmbeddings(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth',
          chunk_text: 'Current body', embedding: vector(), model }], signature)).toBe(true);
        if (staleProof === 'null') {
          await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash=NULL WHERE page_id=$1', [f.snapshot.page.id]);
        } else {
          const corpus = (await engine.executeRaw<{ corpus_generation: string | null }>(
            'SELECT corpus_generation FROM pages WHERE id=$1', [f.snapshot.page.id]))[0]!.corpus_generation;
          const context = embeddingInputContext({ column: prepared.embeddingColumn, provenanceModel: model },
            staleProof === 'old-title' ? 'Previous title' : f.snapshot.page.title, corpus, prepared.chunks);
          const proof = staleProof === 'legacy'
            ? digest(['embedding-input-v1', prepared.embeddingColumn.name, model, prepared.embeddingColumn.dimensions,
              plainEmbeddingTier(f.snapshot.page.contextual_retrieval_mode), null, sha256('Current body')])
            : embeddingInputHash(context, plainEmbeddingTier(f.snapshot.page.contextual_retrieval_mode), prepared.chunks[0]!);
          await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash=$2 WHERE page_id=$1', [f.snapshot.page.id, proof]);
        }

        let calls = 0;
        const states = await embed(f.effectId, async (texts, options) => {
          calls++;
          expect(texts).toEqual(['Current body']);
          expect(options?.documentTitle).toBe(f.snapshot.page.title);
          expect(options?.maxRetries).toBe(0);
          return [vector()];
        });
        expect(calls).toBe(1);
        expect(states[0]?.state).toBe('committed');
        const [stored] = await engine.executeRaw<{ embedding_input_hash: string; embedding: string }>(
          'SELECT embedding_input_hash, embedding::text FROM content_chunks WHERE page_id=$1', [f.snapshot.page.id]);
        const [corpus] = await engine.executeRaw<{ corpus_generation: string | null }>(
          'SELECT corpus_generation FROM pages WHERE id=$1', [f.snapshot.page.id]);
        const expected = embeddingInputHash(embeddingInputContext({ column: prepared.embeddingColumn, provenanceModel: model },
          f.snapshot.page.title, corpus.corpus_generation, prepared.chunks),
        plainEmbeddingTier(f.snapshot.page.contextual_retrieval_mode), prepared.chunks[0]!);
        expect(stored.embedding_input_hash).toBe(expected);
        expect(stored.embedding).toContain('0.25');
      }
    }, 120_000);

    test('a complete current proof does not call the provider', async () => {
      const f = await fixture();
      const prepared = (await readProjectionSnapshot(engine, 'page', f.sourceId))!;
      await installPageEmbeddings(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current body',
        embedding: new Float32Array(1536).fill(0.5), model }], signature);
      let calls = 0;
      const states = await embed(f.effectId, async () => { calls++; return [new Float32Array(1536).fill(0.75)]; });
      expect(calls).toBe(0);
      expect(states[0]?.state).toBe('committed');
      const [stored] = await engine.executeRaw<{ embedding: string }>(
        'SELECT embedding::text FROM content_chunks WHERE page_id=$1', [f.snapshot.page.id]);
      expect(stored.embedding).toContain('0.5');
    }, 120_000);
  });
}
