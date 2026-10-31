/** GBRA-248: doctor embedding_plane_disagreement on PGLite: the file plane against the database's own setting and vectors. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { embeddingPlaneDisagreementCheck } from '../src/commands/doctor/checks/embedding-plane.ts';
import { readStoredEmbeddingIdentity } from '../src/core/stored-embedding-identity.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

describe('embedding_plane_disagreement', () => {
  test('ok until the file disables embeddings over stored vectors the database does not disable', async () => {
    const file = { engine: 'pglite', database_path: '/tmp/example-brain.pglite', embedding_disabled: true } as const;
    expect(await embeddingPlaneDisagreementCheck(engine, { engine: 'pglite' })).toMatchObject({ status: 'ok', details: { file_disabled: false } });
    expect(await embeddingPlaneDisagreementCheck(engine, file)).toMatchObject({ status: 'ok', details: { vector_tables: [] } });
    const stored = (await readStoredEmbeddingIdentity(engine))!;
    await engine.putPage('notes/embedded', { type: 'note', title: 'Embedded', compiled_truth: 'A page with a vector.', timeline: '' });
    await engine.upsertChunks('notes/embedded', [{ chunk_index: 0, chunk_text: 'A page with a vector.', chunk_source: 'compiled_truth', embedding: new Float32Array(stored.dimensions).fill(0.01) }]);
    const warn = await embeddingPlaneDisagreementCheck(engine, file);
    expect(warn).toMatchObject({ status: 'warn', details: { model: stored.model, dimensions: stored.dimensions, vector_tables: ['content_chunks'] } });
    expect(warn.fix).toMatchObject({ consent: ['credentials', 'paid'], actor: 'user', requires_exclusive: true,
      argv: ['gbrain', 'init', '--force', '--embedding-model', stored.model!, '--embedding-dimensions', String(stored.dimensions), '--path', file.database_path] });
    await engine.unsetConfig('embedding_model');
    const unrecorded = await embeddingPlaneDisagreementCheck(engine, file);
    expect(unrecorded).toMatchObject({ status: 'warn', details: { model: null, dimensions: stored.dimensions } });
    expect(unrecorded.fix).toMatchObject({ argv: ['gbrain', 'migrate', 'embeddings', '--status', '--json'], actor: 'agent', consent: [] });
    await engine.setConfig('embedding_model', stored.model!);
    await engine.setConfig('embedding_disabled', 'true');
    expect(await embeddingPlaneDisagreementCheck(engine, file)).toMatchObject({ status: 'ok', details: { database_disabled: true } });
    await engine.unsetConfig('embedding_disabled');
  });
});
