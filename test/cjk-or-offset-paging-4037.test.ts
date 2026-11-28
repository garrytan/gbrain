/**
 * GST-4037 item B: CJK keyword paging with the OR fallback is steady. Page-grain search scores every matching chunk,
 * keeps the best chunk per page and only then applies LIMIT/OFFSET (per-page pooling), and a multi-term strict pass
 * orders its rows exactly as the any-term retry does. Paging through with a small limit therefore returns the same
 * pages, in the same order, as one large request: a long page with many matching chunks no longer fills a chunk pool
 * and pushes shorter pages past a later OFFSET, and a page served by the retry never repeats or skips a strict row.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChunkInput } from '../src/core/types.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const chunk = (chunk_index: number, chunk_text: string): ChunkInput => ({ chunk_index, chunk_text, chunk_source: 'compiled_truth' });

for (const backend of testBackends()) describe(`[${backend}] GST-4037 steady OFFSET paging for CJK OR queries`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const page = async (slug: string, sourceId: string, chunks: string[]) => {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: chunks.join('\n\n') }, { sourceId });
    await installFixtureChunks(engine, slug, chunks.map((text, i) => chunk(i, text)), { sourceId });
  };
  /** Every page of results at `limit`, until a page comes back empty. */
  const paged = async (query: string, sourceId: string, limit: number) => {
    const out: string[] = [];
    for (let offset = 0; offset < 200; offset += limit) {
      const rows = await engine.searchKeyword(query, { sourceId, limit, offset, orFallback: true });
      if (rows.length === 0) break;
      out.push(...rows.map(r => r.slug));
    }
    return out;
  };
  const whole = async (query: string, sourceId: string) => (await engine.searchKeyword(query, { sourceId, limit: 100, orFallback: true })).map(r => r.slug);

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
    for (const id of ['long', 'alts']) await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [id]);
    // One long page whose 40 chunks each match both terms many times, beside short all-term and partial pages.
    await page('notes/long', 'long', Array.from({ length: 40 }, (_, i) => `${'席位升级'.repeat(6)} 段落${i}`));
    for (let i = 0; i < 5; i++) await page(`notes/both-${i}`, 'long', [`席位和升级 ${i}`]);
    for (let i = 0; i < 4; i++) await page(`notes/seats-${i}`, 'long', [`只有席位 ${i}`]);
    // OR alternatives: one strict page repeats its alternative's words, two others hold three of the four words once.
    await page('notes/repeats', 'alts', ['席位升级'.repeat(6)]);
    await page('notes/three-a', 'alts', ['席位升级团队']);
    await page('notes/three-b', 'alts', ['团队管理席位']);
    await page('notes/partial', 'alts', ['只有席位']);
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); await closePostgres?.(); }, 60_000);

  test('a long multi-chunk page beside shorter matching pages: every OFFSET page is a slice of one fixed page order', async () => {
    const all = await whole('席位 升级', 'long');
    expect(new Set(all)).toEqual(new Set(['notes/long', ...[0, 1, 2, 3, 4].map(i => `notes/both-${i}`), ...[0, 1, 2, 3].map(i => `notes/seats-${i}`)]));
    expect(all[0]).toBe('notes/long');
    for (const limit of [1, 2, 3, 4]) {
      const pages = await paged('席位 升级', 'long', limit);
      expect([limit, pages]).toEqual([limit, all]);
    }
  }, 120_000);

  test('OR alternatives: a page the any-term retry serves never repeats or skips a row an earlier strict page returned', async () => {
    const q = '席位 升级 OR 团队 管理';
    const all = await whole(q, 'alts');
    expect(all).toHaveLength(4);
    expect(all[3]).toBe('notes/partial');
    for (const limit of [1, 2, 3]) {
      const pages = await paged(q, 'alts', limit);
      expect([limit, pages]).toEqual([limit, all]);
    }
    // The strict pass alone returns the retry's leading rows, in its order.
    const strict = (await engine.searchKeyword(q, { sourceId: 'alts', limit: 100 })).map(r => r.slug);
    expect(strict).toEqual(all.slice(0, 3));
  }, 120_000);
});
