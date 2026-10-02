/**
 * #4616: the embedding gateway refuses vectors an ANN index cannot serve.
 *
 * A zero-norm, NaN or ±Inf vector has no cosine direction, so HNSW silently
 * skips its row and the chunk becomes unreachable by vector search while
 * keyword search still finds it. The refusal (`embedding_zero_norm`) is
 * terminal per item: the other chunks of the batch land, the refused chunk
 * stays unembedded, and the failure names the page's recovery command and
 * docs anchor. Empty inputs never reach the provider.
 *
 * Installs the process-global gateway transport seam (always fake), so this
 * stays a `.serial.test.ts`. Runs on PGLite, and on Postgres when the E2E
 * wrapper provides DATABASE_URL.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { runEmbedCore } from '../src/commands/embed.ts';
import { __setEmbedTransportForTests, configureGateway, embed, resetGateway } from '../src/core/ai/gateway.ts';
import { embedBatch } from '../src/core/embedding.ts';
import { EmbeddingZeroNormError } from '../src/core/ai/embedding-guard.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine, buildWalRepairNotice } from '../src/core/pglite-engine.ts';
import { runReindexVectors } from '../src/commands/reindex-vectors.ts';
import { EMBED_PROBE_TEXT } from '../src/core/embed-stale.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
const BAD: Record<string, number> = { zero: 0, nan: Number.NaN, inf: Number.POSITIVE_INFINITY };

let sent: string[][] = [];
let badValue = 0;

function vectorFor(text: string): number[] {
  if (text.includes('DEGENERATE')) return new Array(DIMS).fill(0).map((_, i) => (i === 0 ? badValue : 0));
  return new Array(DIMS).fill(0.01);
}

beforeAll(() => {
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });
  __setEmbedTransportForTests((async (input: { values: string[] }) => {
    sent.push(input.values.filter(v => v !== EMBED_PROBE_TEXT));
    return { embeddings: input.values.map(vectorFor), usage: { tokens: input.values.length } };
  }) as never);
});

afterAll(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

afterEach(() => { sent = []; badValue = 0; });

describe('#4616 WAL-repair notice', () => {
  test('says indexes were not rebuilt and names the exact rebuild command', () => {
    const notice = buildWalRepairNotice({ dataDir: '/brain/brain.pglite', backupPath: '/brain/backup', backedUpFiles: [], reusedEpisodeBackup: false,
      resetSegment: '000000010000000000000002', timelineId: 1, walSegSize: 16 * 1024 * 1024, repairedAt: '2026-01-01T00:00:00.000Z' });
    expect(notice).not.toContain('Data files were preserved');
    expect(notice).toContain('indexes are not rebuilt');
    expect(notice).toContain('missing from vector search');
    expect(notice).toContain('`gbrain reindex --vectors`');
  });
});

describe('#4616 gateway guard', () => {
  test('empty and whitespace-only inputs are refused before the provider call', async () => {
    const error = await embed(['first input', '   ', 'third input']).catch(e => e);
    expect(error).toBeInstanceOf(EmbeddingZeroNormError);
    expect(error.code).toBe('embedding_zero_norm');
    expect(error.failures).toEqual([{ index: 1, reason: 'empty_input' }]);
    expect(error.vectors[0]).toBeInstanceOf(Float32Array);
    expect(error.vectors[1]).toBeNull();
    expect(error.vectors[2]).toBeInstanceOf(Float32Array);
    expect(sent).toEqual([['first input', 'third input']]);
  });

  test('an all-empty call never reaches the provider', async () => {
    await expect(embed(['', ' \n'])).rejects.toBeInstanceOf(EmbeddingZeroNormError);
    expect(sent).toEqual([]);
  });

  test('a degenerate vector past the first 100-input slice keeps every other slice', async () => {
    badValue = 0;
    const texts = Array.from({ length: 250 }, (_, i) => (i === 180 ? `chunk ${i} DEGENERATE` : `chunk ${i}`));
    const error = await embedBatch(texts, { onBatchComplete: () => {} }).catch(e => e);
    expect(error).toBeInstanceOf(EmbeddingZeroNormError);
    expect(error.failures).toEqual([{ index: 180, reason: 'zero_norm' }]);
    expect(error.vectors.filter(Boolean)).toHaveLength(249);
    expect(error.vectors[180]).toBeNull();
  });
});

for (const kind of testBackends()) describe(`#4616 per-item refusal on write paths (${kind})`, () => {
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({ embedding_dimensions: DIMS } as never); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { if (close) await close(); else await engine.disconnect(); });

  const embeddedIndexes = async (slug: string) => (await engine.executeRaw<{ chunk_index: number }>(
    `SELECT c.chunk_index FROM content_chunks c JOIN pages p ON p.id=c.page_id
      WHERE p.slug=$1 AND p.source_id='default' AND c.embedding IS NOT NULL ORDER BY c.chunk_index`, [slug])).map(r => Number(r.chunk_index));

  for (const [label, value] of Object.entries(BAD)) {
    test(`one ${label} vector in a 100-chunk batch fails that chunk and the other 99 land`, async () => {
      badValue = value;
      const slug = `zero-norm-${label}`;
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
      await installFixtureChunks(engine, slug, Array.from({ length: 100 }, (_, i) => ({
        chunk_index: i, chunk_text: i === 42 ? `chunk ${i} DEGENERATE` : `chunk ${i} body`, chunk_source: 'compiled_truth' as const, token_count: 4,
      })));
      const result = await runEmbedCore(engine, { stale: true, catchUp: true, quiet: true });
      expect(result.embedded).toBe(99);
      expect(result.failures).toBe(1);
      expect(result.failure_samples.join('\n')).toContain('embedding_zero_norm');
      expect(result.failure_samples.join('\n')).toContain(`gbrain embed ${slug}`);
      expect(result.failure_samples.join('\n')).toContain('docs/guides/write-refusals.md#embedding_zero_norm');
      const embedded = await embeddedIndexes(slug);
      expect(embedded).toHaveLength(99);
      expect(embedded).not.toContain(42);
      // The degenerate chunk was sent once and never retried as a transient failure.
      expect(sent.flat().filter(t => t.includes('DEGENERATE'))).toHaveLength(1);
      await engine.deletePage(slug, { sourceId: 'default' });
    });
  }

  test('reindex --vectors rebuilds every HNSW index and vector search still serves the rows', async () => {
    const slug = 'reindex-vectors-fixture';
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: 'vector fixture', chunk_source: 'compiled_truth', token_count: 2,
      embedding: new Float32Array(DIMS).fill(0.01), model: MODEL }]);
    const preview = await runReindexVectors(engine, ['--dry-run', '--json']);
    expect(preview.rebuilt).toBe(0);
    expect(preview.indexes.map(i => i.index)).toContain('idx_chunks_embedding');
    const result = await runReindexVectors(engine, ['--json']);
    expect(result.rebuilt).toBe(preview.indexes.length);
    const hits = await engine.searchVector(new Float32Array(DIMS).fill(0.01), { limit: 5 });
    expect(hits.map(h => h.slug)).toContain(slug);
    await engine.deletePage(slug, { sourceId: 'default' });
  });

  test('an import keeps the usable vectors and leaves the refused chunk for embed --stale', async () => {
    badValue = 0;
    const slug = 'zero-norm-import';
    const sections = Array.from({ length: 6 }, (_, i) => `## Section ${i}\n\n${(i === 3 ? 'DEGENERATE ' : '') + `Paragraph ${i} `.repeat(400)}`);
    const result = await importFromContent(engine, slug, `---\ntype: note\ntitle: Zero norm import\n---\n\n${sections.join('\n\n')}\n`);
    expect(result.status).toBe('imported');
    expect(result.chunks).toBeGreaterThan(1);
    expect(result.embedding_deferred).toBe(true);
    const chunks = await engine.executeRaw<{ chunk_text: string; embedded: boolean }>(
      `SELECT c.chunk_text, c.embedding IS NOT NULL AS embedded FROM content_chunks c JOIN pages p ON p.id=c.page_id
        WHERE p.slug=$1 AND p.source_id='default' ORDER BY c.chunk_index`, [slug]);
    for (const chunk of chunks) expect(chunk.embedded).toBe(!chunk.chunk_text.includes('DEGENERATE'));
    expect(chunks.some(c => !c.embedded)).toBe(true);
    const [page] = await engine.executeRaw<{ embedding_signature: string | null }>(
      "SELECT embedding_signature FROM pages WHERE slug=$1 AND source_id='default'", [slug]);
    expect(page.embedding_signature).toBeNull();
  });
});
