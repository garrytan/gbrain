/**
 * Regression tests for `embed --stale` signature reconciliation.
 *
 * A page can span the 2,000-row stale cursor boundary, so signatures must be
 * recorded from the final database state rather than a cursor-batch subset.
 *
 * This file installs the process-global gateway transport seam, so it remains
 * a `.serial.test.ts`; the transport is always fake and never calls an external provider.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { runEmbedCore } from '../src/commands/embed.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChunkInput } from '../src/core/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
const SIGNATURE = `${MODEL}:${DIMS}`;

type EmbedTransport = (input: { values: string[] }) => Promise<{
  embeddings: number[][];
  usage: { tokens: number };
}>;

let engine: PGLiteEngine;
let transportBehavior: EmbedTransport;
let savedConcurrency: string | undefined;

function fakeTransport(input: { values: string[] }) {
  return Promise.resolve({
    embeddings: input.values.map(() => new Array(DIMS).fill(0.001)),
    usage: { tokens: input.values.length * 4 },
  });
}

async function seedPage(slug: string, chunks: ChunkInput[]): Promise<void> {
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: `# ${slug}`,
  });
  await engine.upsertChunks(slug, chunks);
}

async function pageSignature(slug: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ embedding_signature: string | null }>(
    `SELECT embedding_signature FROM pages WHERE slug = $1 AND source_id = 'default'`,
    [slug],
  );
  return rows[0]?.embedding_signature ?? null;
}

function staleChunk(index: number, text = `stale chunk ${index}`): ChunkInput {
  return {
    chunk_index: index,
    chunk_text: text,
    chunk_source: 'compiled_truth',
    token_count: 4,
  };
}

function embeddedChunk(index: number, model = MODEL): ChunkInput {
  return {
    ...staleChunk(index, `embedded chunk ${index}`),
    embedding: new Float32Array(DIMS).fill(0.002),
    model,
  };
}

beforeAll(async () => {
  savedConcurrency = process.env.GBRAIN_EMBED_CONCURRENCY;
  process.env.GBRAIN_EMBED_CONCURRENCY = '4';
  configureGateway({
    embedding_model: MODEL,
    embedding_dimensions: DIMS,
    env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' },
  });
  __setEmbedTransportForTests(async (input) => transportBehavior(input as { values: string[] }) as never);

  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: DIMS } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  if (savedConcurrency === undefined) delete process.env.GBRAIN_EMBED_CONCURRENCY;
  else process.env.GBRAIN_EMBED_CONCURRENCY = savedConcurrency;
});

beforeEach(async () => {
  transportBehavior = fakeTransport;
  await resetPgliteState(engine);
});

describe('embed --stale page-level signature reconciliation', () => {
  test('drifted page converges across two runs without replacing completed embeddings', async () => {
    const slug = 'drifted-partial';
    const oldModel = 'openai:old-embedding-model';
    const oldSignature = `${oldModel}:${DIMS}`;
    await seedPage(slug, [
      embeddedChunk(0, oldModel),
      embeddedChunk(1, oldModel),
      { ...embeddedChunk(2, oldModel), chunk_text: 'FAIL this chunk' },
    ]);
    await engine.setPageEmbeddingSignature(slug, { signature: oldSignature });
    transportBehavior = async (input) => {
      if (input.values.some((value) => value.includes('FAIL'))) {
        throw Object.assign(new Error('bad embedding input'), { status: 400 });
      }
      return fakeTransport(input);
    };
    const readChunks = () => engine.executeRaw<{
      chunk_index: number; embedded: boolean; embedded_at: string | null;
    }>(
      `SELECT cc.chunk_index, cc.embedding IS NOT NULL AS embedded,
              cc.embedded_at::text AS embedded_at
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = $1 AND p.source_id = 'default' ORDER BY cc.chunk_index`,
      [slug],
    );

    const first = await runEmbedCore(engine, { stale: true, catchUp: true, quiet: true });
    expect(first.embedded).toBe(2);
    expect(first.failures).toBe(1);
    expect(await pageSignature(slug)).toBe(oldSignature);
    const afterFirst = await readChunks();
    expect(afterFirst.map((chunk) => chunk.embedded)).toEqual([true, true, false]);
    expect(afterFirst[0].embedded_at).not.toBeNull();
    expect(afterFirst[1].embedded_at).not.toBeNull();

    transportBehavior = fakeTransport;
    const second = await runEmbedCore(engine, { stale: true, catchUp: true, quiet: true });
    expect(second.embedded).toBe(1);
    expect(second.failures).toBe(0);
    expect(await pageSignature(slug)).toBe(SIGNATURE);
    const afterSecond = await readChunks();
    expect(afterSecond.map((chunk) => chunk.embedded)).toEqual([true, true, true]);
    expect(afterSecond.slice(0, 2)).toEqual(afterFirst.slice(0, 2));
  });

  test('fully-current drifted page is restamped without re-embedding', async () => {
    await seedPage('fully-current', [embeddedChunk(0), embeddedChunk(1)]);
    await engine.setPageEmbeddingSignature('fully-current', { signature: `openai:old:${DIMS}` });

    const result = await runEmbedCore(engine, { stale: true, catchUp: true, quiet: true });

    expect(result.embedded).toBe(0);
    expect(await pageSignature('fully-current')).toBe(SIGNATURE);
    expect(await engine.countStaleChunks({ signature: SIGNATURE })).toBe(0);
  });

  test('old-model chunk on a drifted page is still invalidated and re-embedded', async () => {
    await seedPage('old-model', [embeddedChunk(0, 'openai:old')]);
    await engine.setPageEmbeddingSignature('old-model', { signature: `openai:old:${DIMS}` });

    const result = await runEmbedCore(engine, { stale: true, catchUp: true, quiet: true });

    expect(result.embedded).toBe(1);
    expect(await pageSignature('old-model')).toBe(SIGNATURE);
  });

  test('NULL embedded_text_hash on a drifted page is not preserved', async () => {
    await seedPage('null-hash', [embeddedChunk(0)]);
    await engine.setPageEmbeddingSignature('null-hash', { signature: `openai:old:${DIMS}` });
    await engine.executeRaw(
      `UPDATE content_chunks SET embedded_text_hash = NULL
        WHERE page_id = (SELECT id FROM pages WHERE slug = 'null-hash' AND source_id = 'default')`,
    );

    const result = await runEmbedCore(engine, { stale: true, catchUp: true, quiet: true });

    expect(result.embedded).toBe(1);
    expect(await pageSignature('null-hash')).toBe(SIGNATURE);
  });

  test('page split across the 2,000-row cursor boundary is stamped after the pass', async () => {
    for (let page = 0; page < 40; page++) {
      const chunkCount = page === 39 ? 49 : 50;
      await seedPage(
        `boundary-filler-${page.toString().padStart(2, '0')}`,
        Array.from({ length: chunkCount }, (_, index) =>
          staleChunk(index, `filler page ${page} chunk ${index}`),
        ),
      );
    }
    await seedPage(
      'split-page',
      [staleChunk(0), staleChunk(1)],
    );

    const result = await runEmbedCore(engine, {
      stale: true,
      batchSize: 2_000,
      catchUp: true,
      quiet: true,
    });

    expect(result.embedded).toBe(2_001);
    expect(await pageSignature('split-page')).toBe(SIGNATURE);
  }, 120_000);

  test('one failed chunk prevents the page signature stamp', async () => {
    await seedPage('partial-failure', [
      staleChunk(0, 'good chunk 0'),
      staleChunk(1, 'FAIL this chunk'),
      staleChunk(2, 'good chunk 2'),
    ]);
    transportBehavior = async (input) => {
      if (input.values.some((value) => value.includes('FAIL'))) {
        throw Object.assign(new Error('bad embedding input'), { status: 400 });
      }
      return fakeTransport(input);
    };

    const result = await runEmbedCore(engine, { stale: true, catchUp: true, quiet: true });

    expect(result.embedded).toBe(2);
    expect(result.failures).toBe(1);
    expect(await pageSignature('partial-failure')).toBeNull();
  });

  test('a chunk whose embedded_text_hash does not match current text is not stamped', async () => {
    await seedPage('hash-mismatch', [embeddedChunk(0), staleChunk(1)]);
    await engine.executeRaw(
      `UPDATE content_chunks
          SET embedded_text_hash = 'not-the-current-text-hash'
        WHERE page_id = (SELECT id FROM pages WHERE slug = 'hash-mismatch')
          AND chunk_index = 0`,
    );
    const originalInvalidate = engine.invalidateContentDriftEmbeddings.bind(engine);
    engine.invalidateContentDriftEmbeddings = async () => 0;
    try {
      await runEmbedCore(engine, { stale: true, catchUp: true, quiet: true });
    } finally {
      engine.invalidateContentDriftEmbeddings = originalInvalidate;
    }

    expect(await pageSignature('hash-mismatch')).toBeNull();
  });

  test('a preserved chunk from another model prevents the signature stamp', async () => {
    await seedPage('model-mismatch', [
      embeddedChunk(0, 'openai:old-embedding-model'),
      staleChunk(1),
    ]);

    await runEmbedCore(engine, { stale: true, catchUp: true, quiet: true });

    expect(await pageSignature('model-mismatch')).toBeNull();
  });

  test('a normal single-batch page is still stamped', async () => {
    await seedPage('single-batch', [staleChunk(0), staleChunk(1)]);

    const result = await runEmbedCore(engine, { stale: true, catchUp: true, quiet: true });

    expect(result.embedded).toBe(2);
    expect(await pageSignature('single-batch')).toBe(SIGNATURE);
  });
});
