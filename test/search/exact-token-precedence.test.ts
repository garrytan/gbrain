/**
 * Exact opaque-identifier precedence in hybrid search.
 *
 * A query that is a single opaque token (an id such as `not_07plSpjDUyKyqT`)
 * whose literal appears in exactly one chunk is a lookup, not a topic. The
 * keyword arm finds that chunk, but on a corpus where the semantic arm
 * returns many "close enough" candidates the fused ranking blends the
 * keyword-only hit against high-cosine rows and it lands outside the top 3
 * (the reported shape: the literal hit at rank 10+ behind unrelated notes).
 *
 * The rule pinned here is bounded: when the query is an opaque token and the
 * keyword arm returned a strict whole-token literal match, those rows take
 * precedence over semantic-only candidates before the final limit. Every
 * other query shape is untouched: an absent id produces no exact hit, an
 * opaque token that matches nothing does not promote anything, and a
 * multi-word query ranks exactly as it did without the rule.
 *
 * Hermetic: the vector arm runs through the `queryEmbedFn` seam with
 * deterministic vectors (no provider, no network). The decoys embed close to
 * the query vector; the target chunk has no embedding at all, so it is only
 * reachable through the keyword arm, exactly like a chunk outside the vector
 * pool on a large brain.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import type { HybridSearchMeta, SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;
let dims = 1536;

const TARGET = 'notes/captured-sync';
const ID = 'not_07plSpjDUyKyqT';
const ABSENT_ID = 'not_zzzzAbsentId99';
const OPAQUE_NO_MATCH = 'x7Kq9LmZ4pQ2';
const TYPES = ['person', 'company', 'note'] as const;
const DECOYS = 12;

function unit(fill: (i: number) => number): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = fill(i);
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

// Query direction: every decoy is a slight perturbation of it.
const QUERY_VEC = () => unit((i) => (i % 7 === 0 ? 1 : 0.05));
const decoyVec = (n: number) => unit((i) => (i % 7 === 0 ? 1 : 0.05) + (i % (n + 2) === 0 ? 0.02 : 0));
const queryEmbedFn = () => QUERY_VEC();

async function run(query: string, extra: Record<string, unknown> = {}): Promise<{ results: SearchResult[]; meta: HybridSearchMeta | null }> {
  let meta: HybridSearchMeta | null = null;
  const results = await hybridSearch(engine, query, {
    limit: 10,
    queryEmbedFn,
    onMeta: (m: HybridSearchMeta) => { meta = m; },
    ...extra,
  } as any);
  return { results, meta };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const col = await engine.executeRaw<{ t: string }>(
    `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`,
  );
  const m = /vector\((\d+)\)/.exec(col[0]?.t ?? '');
  if (m) dims = Number(m[1]);

  for (let i = 0; i < DECOYS; i++) {
    const slug = `decoy-${i}`;
    const text = `Quarterly planning summary for the orchard rollout, discussion item ${i}. ` +
      'Budget review, hiring plan and vendor follow-ups were covered.';
    await engine.putPage(slug, { type: TYPES[i % 3], title: `Planning summary ${i}`, compiled_truth: text });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', embedding: decoyVec(i) },
    ]);
  }
  const targetText = `Meeting captured by the recorder. Source record id ${ID} was stored with the transcript.`;
  await engine.putPage(TARGET, { type: 'note', title: 'Captured sync', compiled_truth: targetText });
  // No embedding: only the keyword arm can reach this chunk.
  await engine.upsertChunks(TARGET, [
    { chunk_index: 0, chunk_text: targetText, chunk_source: 'compiled_truth' },
  ]);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('opaque identifier queries', () => {
  test('a literal id that appears in exactly one chunk lands at the top', async () => {
    const { results, meta } = await run(ID);
    const rank = results.findIndex((r) => r.slug === TARGET);
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(3);
    expect(results[0].slug).toBe(TARGET);
    expect(results[0].exact_token).toBe(true);
    expect(results[0].evidence).toBe('keyword_exact');
    expect(meta?.exact_token).toMatchObject({ token: ID, promoted: 1 });
  });

  test('an absent id returns no false exact hit', async () => {
    const { results, meta } = await run(ABSENT_ID);
    expect(results.some((r) => r.exact_token === true)).toBe(false);
    expect(results.some((r) => r.evidence === 'keyword_exact')).toBe(false);
    expect(meta?.exact_token).toBeUndefined();
  });

  test('an opaque token that matches nothing does not promote unrelated semantic results', async () => {
    const withRule = await run(OPAQUE_NO_MATCH);
    const withoutRule = await run(OPAQUE_NO_MATCH, { exact_token_precedence: false });
    expect(withRule.results.some((r) => r.exact_token === true)).toBe(false);
    expect(withRule.results.map((r) => `${r.slug}:${r.chunk_id}`))
      .toEqual(withoutRule.results.map((r) => `${r.slug}:${r.chunk_id}`));
  });

  test('multi-word queries are unchanged', async () => {
    const withRule = await run('orchard rollout planning');
    const withoutRule = await run('orchard rollout planning', { exact_token_precedence: false });
    expect(withRule.results.some((r) => r.exact_token === true)).toBe(false);
    expect(withRule.meta?.exact_token).toBeUndefined();
    expect(withRule.results.map((r) => `${r.slug}:${r.chunk_id}`))
      .toEqual(withoutRule.results.map((r) => `${r.slug}:${r.chunk_id}`));
  });

  test('the rule is a mode knob: search.exact_token_precedence=false restores the fused order', async () => {
    await engine.setConfig('search.exact_token_precedence', 'false');
    try {
      const { results, meta } = await run(ID);
      expect(results.some((r) => r.exact_token === true)).toBe(false);
      expect(meta?.exact_token).toBeUndefined();
      // Anti-vacuity for the whole file: without the rule the literal hit is
      // buried by the semantic candidates (the reported defect shape).
      const rank = results.findIndex((r) => r.slug === TARGET);
      expect(rank === -1 || rank >= 3).toBe(true);
    } finally {
      await engine.setConfig('search.exact_token_precedence', '');
    }
  });

  test('per-call override false behaves like the config knob', async () => {
    const { results } = await run(ID, { exact_token_precedence: false });
    const rank = results.findIndex((r) => r.slug === TARGET);
    expect(rank === -1 || rank >= 3).toBe(true);
  });
});
