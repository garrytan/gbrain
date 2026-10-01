import { installFixtureChunks } from './helpers/page-projection.ts';
/**
 * #5226 (part 2): `gbrain migrate embeddings --dry-run` reports "to embed"
 * and "to restamp" separately. A stale-signature page whose vectors are
 * already in the target space is only restamped by the live run (#5289), so
 * counting it as re-embed work overstated the preview. On a width change the
 * column is rebuilt, so nothing is restamped. The embed summary line also
 * counts each page once when its stale chunks span listing batches (it read
 * "Embedded 180 chunks across 77 pages" for 60 pages).
 *
 * Installs the process-global gateway transport seam (always fake), so this
 * stays a `.serial.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEmbedCore } from '../src/commands/embed.ts';
import { runMigrateEmbeddings } from '../src/commands/migrate-embeddings.ts';
import { planEmbeddingMigration } from '../src/core/embedding-migration.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { EMBED_PROBE_TEXT } from '../src/core/embed-stale.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
let engine: PGLiteEngine;
let embeddedInputs: string[] = [];
const home = mkdtempSync(join(tmpdir(), 'gbrain-5226-'));

async function seed(target: BrainEngine, slug: string, chunks: number, vectors: { model: string } | null): Promise<void> {
  await target.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
  await installFixtureChunks(target, slug, Array.from({ length: chunks }, (_, i) => ({
    chunk_index: i, chunk_text: `${slug} body ${i}`, chunk_source: 'compiled_truth' as const, token_count: 4,
    ...(vectors ? { embedding: new Float32Array(DIMS).fill(0.002), model: vectors.model } : {}),
  })));
}

beforeAll(async () => {
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });
  __setEmbedTransportForTests((async (input: { values: string[] }) => {
    embeddedInputs.push(...input.values.filter(v => v !== EMBED_PROBE_TEXT));
    return { embeddings: input.values.map(() => new Array(DIMS).fill(0.001)), usage: { tokens: input.values.length * 4 } };
  }) as never);
  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: DIMS } as never);
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  embeddedInputs = [];
});

describe('#5226 migrate embeddings dry run', () => {
  test('same-space vectors are counted as restamp, not re-embed, and the live pass embeds exactly the to-embed figure', async () => {
    await seed(engine, 'current-vectors', 2, { model: MODEL });
    await seed(engine, 'legacy-vectors', 1, { model: 'legacy:model' });
    await seed(engine, 'no-vectors', 1, null);

    const plan = await planEmbeddingMigration(engine, { to: MODEL, dim: DIMS, fromModel: 'legacy:model', fromDims: DIMS });
    expect(plan.dim_change).toBe(false);
    expect(plan.chunks_to_embed).toBe(2);
    expect(plan.chunks_to_restamp).toBe(2);

    const live = await runEmbedCore(engine, { stale: true, includeNullSignature: true, catchUp: true, quiet: true });
    expect(live.embedded).toBe(plan.chunks_to_embed);
    expect(embeddedInputs.sort()).toEqual(['legacy-vectors body 0', 'no-vectors body 0']);
  });

  test('a width change restamps nothing', async () => {
    await seed(engine, 'current-vectors', 2, { model: MODEL });
    await seed(engine, 'no-vectors', 1, null);
    const plan = await planEmbeddingMigration(engine, { to: 'openai:text-embedding-3-small', dim: 1024, fromModel: MODEL, fromDims: DIMS });
    expect(plan.dim_change).toBe(true);
    expect(plan.chunks_to_restamp).toBe(0);
    expect(plan.chunks_to_embed).toBe(3);
  });

  test('the printed plan names both figures', async () => {
    await seed(engine, 'current-vectors', 2, { model: MODEL });
    await seed(engine, 'no-vectors', 1, null);
    const out: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    const err = spyOn(console, 'error').mockImplementation(() => {});
    let code: number | undefined;
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined }, () =>
        runMigrateEmbeddings(engine, ['--to', MODEL, '--dim', String(DIMS), '--dry-run'], {
          exit: (c: number) => { code = c; throw new Error(`exit ${c}`); },
        })).catch((e: Error) => { if (!e.message.startsWith('exit ')) throw e; });
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Work: 1 chunks to embed, 2 to restamp');
    expect(text).toContain('Chunks to restamp: 2');
    expect(embeddedInputs).toEqual([]);
  });
});

describe('#5226 embed summary line', () => {
  test('a page whose stale chunks span listing batches is counted once', async () => {
    for (const slug of ['a-page', 'b-page', 'c-page']) await seed(engine, slug, 3, null);
    const out: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    try {
      await runEmbedCore(engine, { stale: true, includeNullSignature: true, catchUp: true, batchSize: 2 });
    } finally {
      log.mockRestore();
    }
    expect(out.find(l => l.startsWith('Embedded '))).toBe('Embedded 9 chunks across 3 pages');
  });
});
