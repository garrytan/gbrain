import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { planEmbeddingMigration, runSchemaTransition } from '../src/core/embedding-migration.ts';
import { planMigrationWorstCase } from '../src/core/embedding-migration-worst-case.ts';

const MODEL = 'ollama:embeddinggemma';
const DIMS = 8;
const claims = ['Legacy claim', 'Claim text changed', 'Old model claim'];

describe('embedding migration take ceilings', () => {
  let engine: BrainEngine;
  let modelCalls = 0;

  const migration = (model = MODEL, dims = DIMS) => planEmbeddingMigration(engine, { to: model, dim: dims });
  const worstCase = (model = MODEL, dims = DIMS) => migration(model, dims).then(plan => planMigrationWorstCase(engine, plan));

  async function seedPage(slug: string, rows: Array<{ claim: string; active?: boolean }>) {
    const page = await engine.putPage(slug, { type: 'person', title: slug, compiled_truth: '' });
    await engine.addTakesBatch(rows.map((row, i) => ({
      page_id: page.id, row_num: i + 1, claim: row.claim, kind: 'bet', holder: 'world', weight: 0.5,
      active: row.active ?? true, superseded_by: null,
    })));
    return engine.executeRaw<{ id: number; claim: string; row_num: number }>(
      'SELECT id, claim, row_num FROM takes WHERE page_id=$1 ORDER BY row_num', [page.id]);
  }

  async function setVector(id: number, claim: string, model = MODEL) {
    await engine.updateTakeEmbeddings([{ take_id: id, claim, model, embedding: new Float32Array(DIMS).fill(0.125) }]);
  }

  beforeAll(async () => {
    const pglite = new PGLiteEngine();
    engine = pglite;
    await pglite.connect({});
    await pglite.initSchema();
    await runSchemaTransition(engine, DIMS);
    await engine.setConfig('embedding_model', MODEL);
    await engine.setConfig('embedding_dimensions', String(DIMS));
    __setEmbedTransportForTests(async () => {
      modelCalls++;
      throw new Error('migration planning must not call an embedding model');
    });
  }, 120_000);

  beforeEach(async () => {
    await engine.executeRaw('TRUNCATE takes, pages CASCADE');
    await engine.setConfig('takes.auto_embed', 'false');
    modelCalls = 0;
  });

  afterAll(async () => {
    __setEmbedTransportForTests(null);
    await engine.disconnect();
  });

  test('counts eligible persisted takes and excludes current vectors and ineligible rows', async () => {
    const valid = (await seedPage('takes/valid', [{ claim: 'Current target vector' }]))[0]!;
    await setVector(valid.id, valid.claim);

    const stale = await seedPage('takes/stale', claims.map(claim => ({ claim })));
    await setVector(stale[1]!.id, stale[1]!.claim);
    await engine.executeRaw('UPDATE takes SET embedded_text_hash=$1 WHERE id=$2', ['old-claim-hash', stale[1]!.id]);
    await setVector(stale[2]!.id, stale[2]!.claim, 'ollama:nomic-embed-text');

    await seedPage('takes/inactive', [{ claim: 'Inactive claim', active: false }]);
    const deleted = (await seedPage('takes/deleted', [{ claim: 'Deleted page claim' }]))[0]!;
    await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE id=(SELECT page_id FROM takes WHERE id=$1)', [deleted.id]);
    await engine.executeRaw("INSERT INTO sources (id, name, archived) VALUES ('takes-archived', 'takes-archived', true)");
    await engine.putPage('takes/archived', { type: 'person', title: 'Archived', compiled_truth: '' }, { sourceId: 'takes-archived' });
    const [archivedPage] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='takes/archived'");
    await engine.addTakesBatch([{ page_id: archivedPage!.id, row_num: 1, claim: 'Archived source claim', kind: 'bet', holder: 'world', weight: 0.5, active: true, superseded_by: null }]);

    const takeIds = [stale[0]!.id, stale[1]!.id, stale[2]!.id];
    await engine.executeRaw('UPDATE takes SET active=false WHERE id=ANY($1::bigint[])', [takeIds]);
    const baseline = await worstCase();
    const baselinePlan = await migration();
    expect(baselinePlan.takes_to_embed).toBe(0);
    await engine.executeRaw('UPDATE takes SET active=true WHERE id=ANY($1::bigint[])', [takeIds]);

    const before = await engine.executeRaw(
      'SELECT id, claim, active, embedding::text AS embedding, embedding_model, embedded_text_hash FROM takes ORDER BY id');
    const plan = await migration();
    expect(plan.takes_to_embed).toBe(3);
    expect((await engine.listStaleTakes({ model: MODEL, dims: DIMS })).map(row => row.claim)).toEqual(claims);
    const ceiling = await planMigrationWorstCase(engine, plan);
    expect(ceiling.requests - baseline.requests).toBe(1);
    expect(ceiling.input_tokens - baseline.input_tokens).toBe(claims.reduce((n, claim) => n + Buffer.byteLength(`title: none | text: ${claim}`), 0));
    expect(await engine.executeRaw(
      'SELECT id, claim, active, embedding::text AS embedding, embedding_model, embedded_text_hash FROM takes ORDER BY id')).toEqual(before);
    expect(modelCalls).toBe(0);
  });

  test('counts vectors stale only because the migration target width changed', async () => {
    const [take] = await seedPage('takes/dimension', [{ claim: 'Eight dimensional vector' }]);
    await setVector(take!.id, take!.claim);
    expect((await migration(MODEL, DIMS)).takes_to_embed).toBe(0);
    expect((await migration(MODEL, DIMS + 1)).takes_to_embed).toBe(1);
    expect(modelCalls).toBe(0);
  });

  test('uses EmbeddingGemma title:none formatting and leaves other models raw', async () => {
    const [take] = await seedPage('takes/format', [{ claim: 'A title-free take claim' }]);
    await engine.executeRaw('UPDATE takes SET active=false WHERE id=$1', [take!.id]);
    const gemmaBase = await worstCase();
    await engine.executeRaw('UPDATE takes SET active=true WHERE id=$1', [take!.id]);
    const gemmaWithTake = await worstCase();
    expect(gemmaWithTake.input_tokens - gemmaBase.input_tokens).toBe(Buffer.byteLength('title: none | text: A title-free take claim'));

    await engine.executeRaw('UPDATE takes SET active=false WHERE id=$1', [take!.id]);
    const openaiBase = await worstCase('openai:text-embedding-3-small');
    await engine.executeRaw('UPDATE takes SET active=true WHERE id=$1', [take!.id]);
    const openaiWithTake = await worstCase('openai:text-embedding-3-small');
    expect(openaiWithTake.input_tokens - openaiBase.input_tokens).toBe(Buffer.byteLength('A title-free take claim'));
    expect(modelCalls).toBe(0);
  });

  test('matches the drain 100-take batch across the boundary', async () => {
    const many = await seedPage('takes/batch-boundary', Array.from({ length: 101 }, (_, i) => ({ claim: `Claim ${i}` })));
    const ids = many.map(row => row.id);
    await engine.executeRaw('UPDATE takes SET active=false WHERE id=ANY($1::bigint[])', [ids]);
    const baseline = await worstCase();
    await engine.executeRaw('UPDATE takes SET active=true WHERE id=ANY($1::bigint[])', [ids]);
    const plan = await migration();
    expect(plan.takes_to_embed).toBe(101);
    const ceiling = await planMigrationWorstCase(engine, plan);
    expect(ceiling.requests - baseline.requests).toBe(8);
    expect(ceiling.input_tokens - baseline.input_tokens).toBe(many.reduce((n, row) => n + Buffer.byteLength(`title: none | text: ${row.claim}`), 0));
    expect(modelCalls).toBe(0);
  });
});
