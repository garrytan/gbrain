import { installFixtureChunks } from './helpers/page-projection.ts';
/**
 * #5289 residual: `embed --stale --dry-run --include-null-signature` must not
 * count restamp-only chunks as work to embed.
 *
 * A NULL-signature page whose vectors are already in the current embedding
 * space is only restamped by the live run; its vectors are kept. Before the
 * fix the dry run added those chunks to `would_embed`, so the preview named
 * more embedding work (and cost) than the live run then did.
 *
 * Installs the process-global gateway transport seam (always fake), so this
 * stays a `.serial.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { runEmbedCore } from '../src/commands/embed.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { EMBED_PROBE_TEXT } from '../src/core/embed-stale.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';

let embeddedInputs: string[] = [];

async function seed(engine: BrainEngine, slug: string, chunk: { embedded: boolean; model?: string }): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
  await installFixtureChunks(engine, slug, [{
    chunk_index: 0, chunk_text: `${slug} body`, chunk_source: 'compiled_truth', token_count: 4,
    ...(chunk.embedded ? { embedding: new Float32Array(DIMS).fill(0.002), model: chunk.model ?? MODEL } : {}),
  }]);
}

beforeAll(() => {
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });
  __setEmbedTransportForTests((async (input: { values: string[] }) => {
    embeddedInputs.push(...input.values.filter(v => v !== EMBED_PROBE_TEXT));
    return { embeddings: input.values.map(() => new Array(DIMS).fill(0.001)), usage: { tokens: input.values.length * 4 } };
  }) as never);
});

afterAll(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

for (const kind of testBackends()) describe(`#5289 embed --stale dry run vs live run (${kind})`, () => {
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({ embedding_dimensions: DIMS } as never); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { if (close) await close(); else await engine.disconnect(); });
  beforeEach(() => { embeddedInputs = []; });

  test('restamp-only chunks are reported apart from chunks to embed, and the dry run matches the live run', async () => {
    await seed(engine, 'current-vectors', { embedded: true });
    await seed(engine, 'legacy-vectors', { embedded: true, model: 'legacy:model' });
    await seed(engine, 'no-vectors', { embedded: false });
    const opts = { stale: true, includeNullSignature: true, catchUp: true, quiet: true } as const;

    const preview = await runEmbedCore(engine, { ...opts, dryRun: true });
    expect(preview.would_embed).toBe(2);
    expect(preview.would_restamp).toBe(1);
    expect(embeddedInputs).toEqual([]);

    const live = await runEmbedCore(engine, opts);
    expect(live.embedded).toBe(preview.would_embed);
    expect(embeddedInputs.sort()).toEqual(['legacy-vectors body', 'no-vectors body']);

    const after = await runEmbedCore(engine, { ...opts, dryRun: true });
    expect(after.would_embed).toBe(0);
    expect(after.would_restamp ?? 0).toBe(0);
  });
});
