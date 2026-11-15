/**
 * #8533: chunks embedded before provider-prefixed model labels store the bare model name (`text-embedding-3-large`)
 * while the brain's model is prefixed (`openai:text-embedding-3-large`). The false-stamp check already treated that
 * label as the same model, but a projection rebuild that preserves embeddings and the stale-signature invalidation
 * compared labels exactly, so they nulled vectors whose text hash and width were correct and queued a paid re-embed.
 * Every one of those predicates now compares labels through one rule (chunkModelMatchesSql): a bare tail counts only
 * when the stored vector's width equals the target dimensions, and an explicit different prefix never counts.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { countFalseStampedChunks, invalidateStaleSignatureEmbeddingsGuarded } from '../src/core/embedding-invalidation.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { testBackends } from './helpers/test-backends.ts';

const MODEL = 'openai:text-embedding-3-large';
const TEXT = 'A synthetic page body about example widgets.';

async function brainWith(label: string, run: (engine: BrainEngine, pageId: number, dims: number) => Promise<void>, databaseUrl?: string, model = MODEL) {
  const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
  try {
    await engine.setConfig('embedding_model', model);
    const [{ dims }] = await engine.executeRaw<{ dims: number }>("SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'");
    await engine.putPage('notes/bare-label-example', { type: 'note', title: 'Bare label example', compiled_truth: TEXT });
    await installFixtureChunks(engine, 'notes/bare-label-example', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: TEXT }]);
    const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='notes/bare-label-example'");
    await engine.executeRaw(`UPDATE content_chunks SET embedding=array_fill(0.1::real, ARRAY[${Number(dims)}])::vector, model=$2, embedded_at=now(),
      embedded_text_hash=md5(chunk_text) WHERE page_id=$1`, [page!.id, label]);
    await run(engine, Number(page!.id), Number(dims));
  } finally { await close(); }
}
const vectors = async (engine: BrainEngine, pageId: number) => (await engine.executeRaw<{ kept: boolean }>(
  'SELECT embedding IS NOT NULL AS kept FROM content_chunks WHERE page_id=$1 ORDER BY chunk_index', [pageId])).map(r => r.kept);

for (const backend of testBackends()) {
  const url = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  describe(`#8533 a bare model label keeps its vector (${backend})`, () => {
    for (const label of [MODEL, 'text-embedding-3-large']) {
      test(`projection rebuild preserving embeddings keeps a chunk labelled ${label}`, () => brainWith(label, async (engine, pageId) => {
        await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [pageId]);
        await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason) SELECT s.incarnation,p.slug,p.knowledge_revision,'protocol_activation'
          FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.id=$1 ON CONFLICT DO NOTHING`, [pageId]);
        expect((await rebuildPendingPageProjections(engine, 20)).rebuilt).toBeGreaterThan(0);
        expect(await vectors(engine, pageId)).toEqual([true]);
      }, url), 120_000);

      test(`stale-signature invalidation keeps a chunk labelled ${label}`, () => brainWith(label, async (engine, pageId, dims) => {
        await engine.executeRaw('UPDATE pages SET embedding_signature=NULL WHERE id=$1', [pageId]);
        await invalidateStaleSignatureEmbeddingsGuarded(engine, { signature: `${MODEL}:${dims}`, includeNullSignature: true });
        expect(await vectors(engine, pageId)).toEqual([true]);
      }, url), 120_000);
    }

    test('a bare label whose vector width differs from the target dimensions is still invalidated', () => brainWith('text-embedding-3-large', async (engine, pageId, dims) => {
      await engine.executeRaw('UPDATE pages SET embedding_signature=$2 WHERE id=$1', [pageId, `${MODEL}:${dims + 1}`]);
      expect((await countFalseStampedChunks(engine, MODEL, dims + 1)).chunks).toBe(1);
      await engine.executeRaw('UPDATE pages SET embedding_signature=NULL WHERE id=$1', [pageId]);
      await invalidateStaleSignatureEmbeddingsGuarded(engine, { signature: `${MODEL}:${dims + 1}`, includeNullSignature: true });
      expect(await vectors(engine, pageId)).toEqual([false]);
    }, url), 120_000);

    const OLLAMA = 'ollama:example-model:latest';
    test('an explicit different provider prefix is still invalidated by the stale-signature check', () => brainWith('openai:example-model:latest', async (engine, pageId, dims) => {
      await engine.executeRaw('UPDATE pages SET embedding_signature=$2 WHERE id=$1', [pageId, `${OLLAMA}:${dims}`]);
      expect((await countFalseStampedChunks(engine, OLLAMA, dims)).chunks).toBe(1);
      await engine.executeRaw('UPDATE pages SET embedding_signature=NULL WHERE id=$1', [pageId]);
      await invalidateStaleSignatureEmbeddingsGuarded(engine, { signature: `${OLLAMA}:${dims}`, includeNullSignature: true });
      expect(await vectors(engine, pageId)).toEqual([false]);
    }, url, OLLAMA), 120_000);

    test('an explicit different provider prefix is still invalidated by a projection rebuild', () => brainWith('openai:example-model:latest', async (engine, pageId) => {
      await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [pageId]);
      await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason) SELECT s.incarnation,p.slug,p.knowledge_revision,'protocol_activation'
        FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.id=$1 ON CONFLICT DO NOTHING`, [pageId]);
      expect((await rebuildPendingPageProjections(engine, 20)).rebuilt).toBeGreaterThan(0);
      expect(await vectors(engine, pageId)).toEqual([false]);
    }, url, OLLAMA), 120_000);
  });
}
