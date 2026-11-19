/**
 * A Rust brain records the same embedding model and width config rows at initSchema as PGLite does.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: after initSchema on a fresh Rust brain, the `embedding_model` and `embedding_dimensions` config rows
 *    equal the rows a fresh PGLite brain records in the same process, an existing row is kept as PGLite's
 *    `ON CONFLICT DO NOTHING` keeps it, and doctor `embedding_identity_unqualified` and `fact_take_vectors` give the
 *    PGLite answer.
 *  - Regression: the Rust initSchema did nothing, so a Rust base brain recorded no model and width; doctor
 *    `fact_take_vectors` warned `vectors_not_verified` where PGLite reported ok, and `embedding_identity_unqualified`
 *    reported "records no embedding_model" where PGLite named the model.
 *  - Why existing coverage misses it: the parity harness never calls initSchema on the Rust arm, and the lane 12
 *    doctor census is not a test.
 *  - Seam: none. Both engines run initSchema; the gateway model is the one the test preload configures.
 *    Needs the Rust addon: skipped without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { embeddingIdentityEntry } from '../src/commands/doctor/checks/embedding-identity.ts';
import { factTakeVectorsEntry } from '../src/commands/doctor/checks/vector-coverage.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const required = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';
const run = existsSync(rustArmAddonPath()) || required ? test : test.skip;
const KEYS = ['embedding_model', 'embedding_dimensions'] as const;

async function rows(engine: BrainEngine): Promise<Record<string, string | null>> {
  return Object.fromEntries(await Promise.all(KEYS.map(async k => [k, await engine.getConfig(k)] as const)));
}

async function doctor(engine: BrainEngine): Promise<Array<Pick<Check, 'name' | 'status' | 'message'>>> {
  const ctx = { engine, progress: { heartbeat() {} } } as unknown as DoctorContext;
  const checks = [...await embeddingIdentityEntry.run(ctx) as Check[], ...await factTakeVectorsEntry.run(ctx) as Check[]];
  return checks.map(({ name, status, message }) => ({ name, status, message }));
}

describe('embedding config rows at initSchema on a Rust brain', () => {
  const dirs: string[] = [];
  const engines: BrainEngine[] = [];
  let pglite: BrainEngine;

  async function freshRust(): Promise<BrainEngine> {
    const brain = await openRustBrain();
    dirs.push(brain.dir);
    const engine = brain.engine as unknown as BrainEngine;
    engines.push(engine);
    return engine;
  }

  beforeAll(async () => {
    pglite = new PGLiteEngine();
    await pglite.connect({ engine: 'pglite' } as never);
    await pglite.initSchema();
    engines.push(pglite);
  }, 120_000);

  afterAll(async () => {
    for (const engine of engines) await engine.disconnect().catch(() => {});
    for (const dir of dirs) removeBrainDir(dir);
  });

  run('a fresh Rust brain records the model and width a fresh PGLite brain records', async () => {
    const engine = await freshRust();
    await engine.initSchema();
    const expected = await rows(pglite);
    expect(expected.embedding_model).toBeTruthy();
    expect(await rows(engine)).toEqual(expected);
  }, 60_000);

  run('initSchema keeps rows the brain already records', async () => {
    const engine = await freshRust();
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-small');
    await engine.setConfig('embedding_dimensions', '512');
    await engine.initSchema();
    await engine.initSchema();
    expect(await rows(engine)).toEqual({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: '512' });
  }, 60_000);

  run('doctor embedding_identity_unqualified and fact_take_vectors answer as on PGLite', async () => {
    const engine = await freshRust();
    await engine.initSchema();
    const answers = await doctor(engine);
    expect(answers).toEqual(await doctor(pglite));
    expect(answers.map(c => c.status)).toEqual(['ok', 'ok']);
  }, 60_000);
});
