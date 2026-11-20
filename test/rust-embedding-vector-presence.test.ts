/**
 * The three init and doctor sites that ask whether a brain already holds vectors answer on a Rust brain.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: on a Rust brain with stored vectors, a keyless re-init from a cold home keeps the stored embedding
 *    identity (keptEmbeddingIdentity), an init for another model refuses (assertInitEmbeddingIdentity), and doctor
 *    embedding_plane_disagreement names the store that holds vectors.
 *  - Regression: the three sites read `SELECT EXISTS (... WHERE embedding IS NOT NULL)` through `executeRaw`, which the
 *    Rust engine refuses, so the re-init kept nothing, the refusal never fired and doctor reported an unknown state.
 *  - Why existing coverage misses it: test/init-cold-home-embedding.test.ts and
 *    test/doctor-embedding-plane-disagreement.test.ts run on PGLite and Postgres only.
 *  - Seam: none. The vectors are stored through upsertChunks; the sites call the typed member hasStoredVectors.
 *    Needs the Rust addon: skipped without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import type { BrainEngine } from '../src/core/engine.ts';
import { keptEmbeddingIdentity } from '../src/commands/init-embedding-plane.ts';
import { assertInitEmbeddingIdentity, type ResolvedAIOptions } from '../src/commands/init.ts';
import { embeddingPlaneDisagreementCheck } from '../src/commands/doctor/checks/embedding-plane.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';
import { basisEmbedding } from './engine-parity/harness.ts';

const required = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';
const run = existsSync(rustArmAddonPath()) || required ? test : test.skip;
const MODEL = 'model-a';

describe('vector presence on a Rust brain', () => {
  let engine: BrainEngine;
  let dir: string | undefined;

  beforeAll(async () => {
    if (!existsSync(rustArmAddonPath()) && !required) return;
    const brain = await openRustBrain();
    dir = brain.dir;
    engine = brain.engine as unknown as BrainEngine;
    await engine.setConfig('embedding_dimensions', '1536');
    await engine.setConfig('embedding_model', MODEL);
    await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'alpha body' });
    await engine.upsertChunks('notes/a', [{ chunk_index: 0, chunk_text: 'alpha body', chunk_source: 'compiled_truth', embedding: basisEmbedding(3), model: MODEL }]);
  }, 60_000);

  afterAll(async () => {
    if (!dir) return;
    await engine.disconnect().catch(() => {});
    removeBrainDir(dir);
  });

  run('a keyless re-init from a cold home keeps the stored identity', async () => {
    const keyless = { noEmbedding: true, implicitKeyless: true } as ResolvedAIOptions;
    expect(await keptEmbeddingIdentity(engine, keyless, false)).toEqual({ model: MODEL, dimensions: 1536 });
  });

  run('an init for another model refuses over the stored vectors', async () => {
    await expect(assertInitEmbeddingIdentity(engine, 'model-b')).rejects.toThrow('Existing vectors belong to a different or unrecorded embedding model');
    await assertInitEmbeddingIdentity(engine, MODEL);
  });

  run('doctor names the store that holds vectors', async () => {
    const check = await embeddingPlaneDisagreementCheck(engine, { engine: 'rust', embedding_disabled: true } as never);
    expect(check).toMatchObject({ status: 'warn', details: { vector_tables: ['content_chunks'], model: MODEL, dimensions: 1536 } });
  });
});
