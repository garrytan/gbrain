import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { runSchemaTransition } from '../../src/core/embedding-migration.ts';
import { readProjectionSnapshot, installPageEmbeddings, rebuildPendingPageProjections } from '../../src/core/page-state/projections.ts';
import { recordFactWithdrawal } from '../../src/core/facts/withdrawal.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { migrationWaveFixture } from '../helpers/migration-wave-fixture.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';

const model = 'openai:text-embedding-3-small';
const vector = new Float32Array(8).fill(0.25);
for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`migration wave prepared publication (${kind})`, () => {
    let fixture: Awaited<ReturnType<typeof migrationWaveFixture>>;
    let engine: BrainEngine;
    beforeAll(async () => {
      fixture = await migrationWaveFixture(kind); engine = fixture.engine;
      await runSchemaTransition(engine, 8);
      await engine.setConfig('embedding_model', model);
      await engine.setConfig('embedding_dimensions', '8');
      configureGateway({ embedding_model: model, embedding_dimensions: 8, env: {} });
    }, 60_000);
    afterAll(async () => { resetGateway(); await fixture?.close(); });
    for (const order of ['withdraw-first', 'install-first']) {
      test(`${order}: delayed real vector installation never resurrects a withdrawn claim`, async () => {
        const sourceId = `synthetic-${order}`;
        const slug = 'synthetic-claim';
        const claim = `withdrawalsentinel ${order} synthetic claim`;
        await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
        await engine.putPage(slug, { type: 'note', title: 'Synthetic race', compiled_truth: 'Safe retained prose', timeline: renderFactsTable([
          { rowNum: 1, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true },
        ]) }, { sourceId });
        await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'timeline', chunk_text: claim }], { sourceId });
        const fact = await engine.insertFact({ fact: claim, source: 'synthetic', visibility: 'world' }, { source_id: sourceId });
        const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
        const install = () => installPageEmbeddings(engine, prepared, prepared.chunks.map(chunk => ({ chunk_index: chunk.chunk_index, chunk_source: chunk.chunk_source, chunk_text: chunk.chunk_text, embedding: vector })), `${model}:8`);
        if (order === 'install-first') {
          expect(await install()).toBe(true);
          expect(await engine.searchVector(vector, { sourceId })).toHaveLength(1);
        }
        expect((await recordFactWithdrawal(engine, fact.id, sourceId, true)).withdrawn).toBe(true);
        expect(await install()).toBe(false);
        expect(await engine.searchVector(vector, { sourceId })).toEqual([]);
        expect(await engine.searchKeyword('withdrawalsentinel', { sourceId })).toEqual([]);
        expect((await rebuildPendingPageProjections(engine, 100)).rebuilt).toBeGreaterThan(0);
        expect((await engine.getChunks(slug, { sourceId })).map(c => c.chunk_text).join('\n')).not.toContain(claim);
        expect(await install()).toBe(false);
        expect(await engine.searchKeyword('withdrawalsentinel', { sourceId })).toEqual([]);
      });
    }
    for (const change of ['source', 'model', 'soft-deleted-page'] as const) {
      test(`${change} change rejects a prepared vector without changing the replacement state`, async () => {
        const sourceId = `synthetic-prepared-${change}`;
        const slug = 'synthetic-prepared';
        await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Synthetic stable content' }, { sourceId });
        await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Synthetic stable content' }], { sourceId });
        const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
        if (change === 'source') await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
        else if (change === 'model') await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
        else expect(await engine.softDeletePage(slug, { sourceId })).not.toBeNull();
        const before = await engine.executeRaw('SELECT to_jsonb(c) AS chunk FROM content_chunks c WHERE page_id=$1 ORDER BY id', [prepared.snapshot.page.id]);
        expect(await installPageEmbeddings(engine, prepared, prepared.chunks.map(chunk => ({ chunk_index: chunk.chunk_index, chunk_source: chunk.chunk_source, chunk_text: chunk.chunk_text, embedding: vector })))).toBe(false);
        expect(await engine.executeRaw('SELECT to_jsonb(c) AS chunk FROM content_chunks c WHERE page_id=$1 ORDER BY id', [prepared.snapshot.page.id])).toEqual(before);
        await engine.setConfig('embedding_model', model);
      });
    }
  });
}
