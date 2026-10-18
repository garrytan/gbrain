/**
 * A3 / T44 + A4: `upsertChunksOnce` writes a page's chunks in bounded batches
 * inside the caller's transaction, prunes once before the first batch, and a
 * stored chunk follows its exact text to a new index.
 *
 * Authoring gate. (1) Contract: a page-scale chunk replacement never binds the
 * whole page as one JSON document (<= 500 rows and <= 16 MiB per statement),
 * keeps every unchanged chunk's vector and embedding metadata in every batch,
 * rolls back completely when any batch fails, and keeps the vectors of
 * chunks a top insert only shifted. (2) Regressions it catches: a per-slice
 * replacement that deletes earlier batches, a prune between batches, a whole-
 * page statement (the 256 MB jsonb ceiling at ~31 MB of page), a partial
 * commit, and index-keyed vector loss on a shift. (3) Existing coverage writes
 * one or two chunks. (4) No production seam: the statements are observed
 * through a wrapper over the engine's own executor.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { upsertChunksOnce } from '../src/core/engine-sql/chunks.ts';
import type { SqlExecutor } from '../src/core/engine-sql/executor.ts';
import type { ChunkInput } from '../src/core/types.ts';
import { ROW_BATCH_MAX_BYTES, ROW_BATCH_MAX_ROWS } from '../src/core/batch-rows.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let dims = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const [row] = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0`);
  dims = Number(row!.dim);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const SLUG = 'notes/batched-chunks-alice-example';

const vec = (seed: number, width = dims) => {
  const v = new Float32Array(width);
  v[seed % width] = 1;
  v[(seed * 7 + 3) % width] = -0.5;
  return v;
};
const text = (i: number, pad = 0) => `Chunk ${i} of acme-example notes.${pad ? ' ' + 'x'.repeat(pad) : ''}`;

const tokens = (chunk: string) => 3 + (chunk.length % 11);

function embedded(texts: string[]): ChunkInput[] {
  return texts.map((chunk_text, i) => ({
    chunk_index: i, chunk_text, chunk_source: 'compiled_truth', embedding: vec(i), model: 'test:batched-model',
    token_count: tokens(chunk_text), embedding_input_hash: `input-${i}`, modality: 'text',
  }));
}

function bare(texts: string[]): ChunkInput[] {
  return texts.map((chunk_text, i) => ({ chunk_index: i, chunk_text, chunk_source: 'compiled_truth', token_count: tokens(chunk_text) }));
}

interface RowState {
  id: number; chunk_index: number; chunk_text: string; vector_md5: string | null; model: string | null; token_count: number | null;
  embedded_at: string | null; embedded_text_hash: string | null; embedding_input_hash: string | null; modality: string;
}

async function state(): Promise<RowState[]> {
  return (await engine.executeRaw<RowState>(`SELECT cc.id, cc.chunk_index, cc.chunk_text, md5(cc.embedding::text) AS vector_md5, cc.model,
      cc.token_count, cc.embedded_at::text AS embedded_at, cc.embedded_text_hash, cc.embedding_input_hash, cc.modality
    FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = $1 AND p.source_id = 'default' ORDER BY cc.chunk_index`, [SLUG]))
    .map(r => ({ ...r, id: Number(r.id), chunk_index: Number(r.chunk_index), token_count: r.token_count === null ? null : Number(r.token_count) }));
}

async function seed(chunks: ChunkInput[]): Promise<RowState[]> {
  await engine.putPage(SLUG, { type: 'note', title: 'Batched chunks', compiled_truth: 'body' });
  await engine.upsertChunks(SLUG, chunks);
  return state();
}

interface Insert { rows: number; bytes: number }

/** Run one replacement through the engine's own executor, recording each chunk INSERT's JSON batch. */
async function write(chunks: ChunkInput[]): Promise<Insert[]> {
  const inserts: Insert[] = [];
  await engine.transaction(async tx => {
    const exec = (tx as unknown as { engineSql: SqlExecutor }).engineSql;
    const observed: SqlExecutor = new Proxy(exec, {
      get(target, key) {
        if (key === 'query') return (sql: string, params?: unknown[], opts?: unknown) => {
          if (/^\s*INSERT INTO content_chunks \(page_id, chunk_index, chunk_text/.test(sql)) {
            const json = params!.find(p => typeof p === 'string' && p.startsWith('[')) as string;
            inserts.push({ rows: (JSON.parse(json) as unknown[]).length, bytes: Buffer.byteLength(json) });
          }
          return target.query(sql, params, opts as never);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await upsertChunksOnce(observed, {
      lockPageKeys: keys => tx.lockPageKeys(keys),
      readPageSnapshot: (slug, opts) => tx.readPageSnapshot(slug, opts),
    }, SLUG, chunks);
  });
  return inserts;
}

describe('A3 / T44: batched chunk replacement', () => {
  for (const n of [499, 500, 501, 1000, 1001]) {
    test(`${n} chunks: ceil(n/500) bounded batches, every vector and its metadata kept`, async () => {
      const texts = Array.from({ length: n }, (_, i) => text(i));
      const before = await seed(embedded(texts));
      expect(before.every(r => r.vector_md5 !== null && r.embedding_input_hash !== null)).toBe(true);
      const inserts = await write(bare(texts));
      expect(inserts.map(i => i.rows)).toEqual(Array.from({ length: Math.ceil(n / ROW_BATCH_MAX_ROWS) },
        (_, b) => Math.min(ROW_BATCH_MAX_ROWS, n - b * ROW_BATCH_MAX_ROWS)));
      expect(await state()).toEqual(before);
    }, 120_000);
  }

  test('the encoded-byte limit splits a batch below the row limit and loses nothing', async () => {
    const texts = Array.from({ length: 420 }, (_, i) => text(i, 40_000));
    const before = await seed(embedded(texts));
    const inserts = await write(bare(texts));
    expect(inserts.length).toBe(2);
    expect(inserts.every(i => i.bytes <= ROW_BATCH_MAX_BYTES && i.rows < ROW_BATCH_MAX_ROWS)).toBe(true);
    expect(inserts.reduce((sum, i) => sum + i.rows, 0)).toBe(420);
    expect(await state()).toEqual(before);
  }, 120_000);

  test('a failure in batch 2 rolls back the prune, the moves and batch 1', async () => {
    const before = await seed(embedded(Array.from({ length: 1001 }, (_, i) => text(i))));
    const [{ chunker_version: sealBefore }] = await engine.executeRaw<{ chunker_version: number | null }>(
      'SELECT chunker_version FROM pages WHERE slug = $1', [SLUG]);
    // A top insert that also drops the tail: moves every row, prunes 102, then batch 2
    // carries a vector of the wrong width.
    const next = bare(['A new opening paragraph.', ...Array.from({ length: 900 }, (_, i) => text(i))]);
    next[700] = { ...next[700]!, embedding: vec(1, dims + 1) };
    const error = await write(next).then(() => null, (e: unknown) => e);
    expect(String(error)).toMatch(/dimension/i);
    expect(await state()).toEqual(before);
    const [{ chunker_version: sealAfter }] = await engine.executeRaw<{ chunker_version: number | null }>(
      'SELECT chunker_version FROM pages WHERE slug = $1', [SLUG]);
    expect(sealAfter).toBe(sealBefore);
  }, 120_000);
});

describe('A4: a stored chunk follows its exact text to a new index', () => {
  test('a top insert keeps the row, vector and metadata of every shifted chunk; only the new chunk waits for a vector', async () => {
    const texts = Array.from({ length: 1001 }, (_, i) => text(i));
    const before = await seed(embedded(texts));
    await write(bare(['A new opening paragraph.', ...texts]));
    const after = await state();
    expect(after).toHaveLength(1002);
    expect(after[0]).toMatchObject({ chunk_index: 0, chunk_text: 'A new opening paragraph.', vector_md5: null, embedded_at: null });
    expect(after.slice(1)).toEqual(before.map(r => ({ ...r, chunk_index: r.chunk_index + 1 })));
  }, 120_000);

  test('a removed opening chunk shifts the rest down without losing their vectors, and its row is gone', async () => {
    const texts = Array.from({ length: 600 }, (_, i) => text(i));
    const before = await seed(embedded(texts));
    await write(bare(texts.slice(1)));
    expect(await state()).toEqual(before.slice(1).map(r => ({ ...r, chunk_index: r.chunk_index - 1 })));
  }, 120_000);

  test('a changed chunk still loses its vector while its unchanged neighbours keep theirs', async () => {
    const texts = Array.from({ length: 5 }, (_, i) => text(i));
    const before = await seed(embedded(texts));
    await write(bare([texts[0]!, 'Rewritten chunk.', texts[2]!, texts[3]!, texts[4]!]));
    const after = await state();
    expect(after[1]).toMatchObject({ chunk_text: 'Rewritten chunk.', vector_md5: null, embedded_at: null, embedding_input_hash: null });
    expect([after[0], after[2], after[3], after[4]]).toEqual([before[0], before[2], before[3], before[4]]);
  });
});
