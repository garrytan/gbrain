/**
 * engine-sql/chunks.ts keeps one fragment copy of the shared
 * `currentSpaceChunkPredicate` (embedding-invalidation.ts), because engine-sql
 * composes with sqlFragment and bans hand-numbered `$n`
 * (docs/designs/refactor-wave-1/w1-inventory.md, chunks). This pins the two
 * texts together so an edit to one cannot silently leave the other behind:
 * the fragment rendered at its placeholder positions must equal the shared
 * builder's text, and bind exactly (model, dims). It also pins
 * `decodeVectorSend` (getEmbeddingsByChunkIds' binary vector decoder) to
 * `tryParseEmbedding` of the same rows' text literal on a real engine, for
 * vector and halfvec columns at real width, and to null on malformed input.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { currentSpaceChunkPredicate } from '../src/core/embedding-invalidation.ts';
import { quoteIdentifier } from '../src/core/search/embedding-column.ts';
import { currentSpaceChunkFragment, decodeVectorSend } from '../src/core/engine-sql/chunks.ts';
import { tryParseEmbedding } from '../src/core/utils.ts';
import { renderFragment } from '../src/core/engine-sql/fragment.ts';

describe('engine-sql chunks: currentSpaceChunkFragment', () => {
  for (const column of ['embedding', 'embedding_voyage']) {
    test(`renders currentSpaceChunkPredicate's exact text for ${column}`, () => {
      const { text, params } = renderFragment(currentSpaceChunkFragment(column, 'voyage:voyage-4', 1024));
      expect(text).toBe(currentSpaceChunkPredicate(quoteIdentifier(column), 1, 2));
      expect(params).toEqual(['voyage:voyage-4', 1024]);
    });
  }
});

describe('engine-sql chunks: decodeVectorSend', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.executeRaw(`CREATE EXTENSION IF NOT EXISTS vector`);
    await engine.executeRaw(`CREATE TABLE send_probe (id int PRIMARY KEY, v vector(1024), h halfvec(1024))`);
    await engine.executeRaw(`INSERT INTO send_probe SELECT i, x.v::vector, x.v::halfvec
      FROM generate_series(1, 40) i
      CROSS JOIN LATERAL (SELECT array_agg(((i * 7919 + g * 104729) % 200003) / 100001.5 - 1 + CASE WHEN g = 3 THEN 1e-7 ELSE 0 END)::real[] AS v FROM generate_series(1, 1024) g) x`);
  });
  afterAll(async () => { await engine.disconnect(); });

  for (const column of ['v', 'h']) {
    test(`binary rows equal the text literal's parse bit for bit (${column === 'v' ? 'vector' : 'halfvec'}(1024))`, async () => {
      const rows = await engine.executeRaw<{ id: number; text: string; bin: Uint8Array }>(
        `SELECT id, ${column}::text AS text, vector_send(${column}::vector) AS bin FROM send_probe ORDER BY id`);
      expect(rows).toHaveLength(40);
      for (const row of rows) {
        const binary = decodeVectorSend(row.bin)!;
        const text = tryParseEmbedding(row.text)!;
        expect(binary).toHaveLength(1024);
        expect(Buffer.from(binary.buffer).equals(Buffer.from(text.buffer))).toBe(true);
      }
    });
  }

  test('malformed or non-binary values decode to null', () => {
    const header = (dims: number, floats: number) => { const b = new Uint8Array(4 + 4 * floats); new DataView(b.buffer).setInt16(0, dims); return b; };
    for (const input of [null, undefined, '[1,2]', [1, 2], new Uint8Array(3), header(3, 2), header(1, 2)]) {
      expect(decodeVectorSend(input)).toBeNull();
    }
    expect(Array.from(decodeVectorSend(header(2, 2))!)).toEqual([0, 0]);
  });
});
