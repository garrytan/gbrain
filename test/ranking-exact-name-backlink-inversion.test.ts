/**
 * #895 — ranking inversion repro receipt.
 *
 * Reported on v0.31.3 (PGLite): `gbrain query "Who is Zhang San"` ranked a
 * heavily-backlinked concept page (concepts/memory-augmented-retrieval,
 * score 1.07) ABOVE the exact-name person page (people/zhangsan, 0.49).
 * The pipeline has since gained title-match boost, backlink floor gating,
 * and NaN guards. This test pins the fixture so the inversion can't return:
 * the exact-name page must outrank the backlink-magnet concept page.
 *
 * Keyword-only path (no embedding provider in test) — the backlink boost
 * applies post-fusion regardless of which recall arm produced the result.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

const FIXTURE: Array<{ slug: string; type: string; title: string; body: string }> = [
  {
    slug: 'people/zhangsan',
    type: 'person',
    title: 'Zhang San',
    body: 'Zhang San, famously known as the forgetful founder, builds memory tools.',
  },
  {
    slug: 'people/lisi',
    type: 'person',
    title: 'Li Si',
    body: 'Li Si, nicknamed "The Spender", works with Zhang San on retrieval experiments.',
  },
  {
    slug: 'companies/goldfish-memory-tech',
    type: 'company',
    title: 'Goldfish Memory Tech',
    body: 'Goldfish Memory Tech was founded by Zhang San to commercialize memory augmentation.',
  },
  {
    slug: 'concepts/memory-augmented-retrieval',
    type: 'concept',
    title: 'Memory Augmented Retrieval',
    body: 'Memory Spa Method. Zhang San popularized memory augmented retrieval as a discipline.',
  },
  {
    slug: 'meetings/may-2026-meetup',
    type: 'meeting',
    title: 'May 2026 Meetup',
    body: 'The symposium was held in May. Zhang San presented the Memory Spa Method.',
  },
];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const p of FIXTURE) {
    await engine.putPage(p.slug, { type: p.type, title: p.title, compiled_truth: p.body });
    // putPage never chunks; the keyword arm joins content_chunks.
    await engine.upsertChunks(p.slug, [
      { chunk_index: 0, chunk_text: p.body, chunk_source: 'compiled_truth' },
    ]);
  }
  // Make the concept page a backlink magnet — the boost source of the
  // reported inversion. Every other page links to it.
  await engine.addLinksBatch(
    FIXTURE.filter(p => p.slug !== 'concepts/memory-augmented-retrieval').map(p => ({
      from_slug: p.slug,
      to_slug: 'concepts/memory-augmented-retrieval',
      link_type: 'mentions',
      link_source: 'markdown',
      context: '',
    })),
  );
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('exact-name page vs backlink-magnet concept page (#895)', () => {
  test('"Who is Zhang San" ranks people/zhangsan first, with finite scores', async () => {
    // Keyword-only path: no embedding provider during the search call.
    const results = await withEnv({ OPENAI_API_KEY: undefined }, () =>
      hybridSearch(engine, 'Who is Zhang San', { limit: 5 }),
    );
    expect(results.length).toBeGreaterThan(1);
    expect(results[0].slug).toBe('people/zhangsan');
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
    }
    // The concept page must not outrank the exact-name page even with
    // backlinks from every other page in the corpus. It IS in the result
    // set (it mentions Zhang San) and it IS backlink-boosted — that's the
    // contested comparison from the report.
    const concept = results.find(r => r.slug === 'concepts/memory-augmented-retrieval');
    expect(concept).toBeDefined();
    expect(concept!.backlink_boost ?? 1).toBeGreaterThan(1);
    expect(results[0].score).toBeGreaterThanOrEqual(concept!.score);
  });
});
