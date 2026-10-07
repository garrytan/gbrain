/**
 * #6043 + #5989: the CJK keyword path honors the hybrid OR fallback with the
 * ASCII-path semantics (only when strict AND returns fewer than the requested
 * rows; ranked by matched-term count, then term frequency), and the bounded
 * arm's capped candidate stage keeps all-term rows ahead of partial ones.
 * Direct searchKeyword callers keep strict AND.
 *
 * R3/R4: engine in beforeAll, disconnect in afterAll; state reset per test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { prepareMarkdownChunks } from '../src/core/markdown-chunks.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function page(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body });
  await installFixtureChunks(engine, slug, await prepareMarkdownChunks({ compiled_truth: body, timeline: '' }));
}

const slugs = (rows: Array<{ slug: string }>) => rows.map((r) => r.slug);

describe('CJK OR fallback (#6043)', () => {
  test('terms in different documents: strict AND finds nothing, the hybrid fallback finds both', async () => {
    await page('notes/seats', '团队版的席位数量由管理员配置。');
    await page('notes/upgrade', '升级到专业版后可以使用更多功能。');
    expect(await engine.searchKeyword('席位 升级')).toEqual([]);
    expect(slugs(await engine.searchKeyword('席位 升级', { orFallback: true })).sort()).toEqual(['notes/seats', 'notes/upgrade']);
  });

  test('when strict AND has at least the requested rows, the result is identical to today', async () => {
    for (let i = 0; i < 3; i++) await page(`notes/both-${i}`, `席位${'。'.repeat(i)}和升级都在这里`);
    await page('notes/only-seats', '席位 席位 席位 席位');
    const strict = await engine.searchKeyword('席位 升级', { limit: 2 });
    const fallback = await engine.searchKeyword('席位 升级', { limit: 2, orFallback: true });
    expect(strict).toHaveLength(2);
    expect(slugs(fallback)).toEqual(slugs(strict));
    expect(fallback.map((r) => r.score)).toEqual(strict.map((r) => r.score));
  });

  test('in the fallback an all-term chunk outranks single-term chunks with a higher term frequency', async () => {
    await page('notes/both', '席位和升级');
    await page('notes/seats-many', '席位 席位 席位 席位 席位 席位');
    await page('notes/upgrade-many', '升级 升级 升级 升级 升级 升级');
    const rows = await engine.searchKeyword('席位 升级', { limit: 5, orFallback: true });
    expect(rows[0]?.slug).toBe('notes/both');
    expect(rows).toHaveLength(3);
  });
});

describe('bounded CJK keyword arm on PGLite (#5989)', () => {
  test('past the chunk threshold the capped stage keeps no partial-term row when all-term matches exceed the cap', async () => {
    for (let i = 0; i < 8; i++) await page(`notes/both-${i}`, `席位和升级 ${i}`);
    for (let i = 0; i < 4; i++) await page(`notes/partial-${i}`, `只有席位 ${i}`);
    await engine.executeRaw('ANALYZE content_chunks');
    const metas: Array<Record<string, unknown>> = [];
    const rows = await engine.searchKeyword('席位 升级', { limit: 20, orFallback: true,
      cjkKeyword: { deadlineMs: 3000, candidateCap: 5, pgliteCappedChunks: 0, onMeta: (m) => metas.push(m as never) } });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.slug.startsWith('notes/both-'))).toBe(true);
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ incomplete: true, reason: 'candidate_budget', capped: true });
  });

  test('a capped stage under the cap is complete and ranks like the full path', async () => {
    await page('notes/both', '席位和升级');
    await page('notes/seats', '席位 席位 席位');
    await engine.executeRaw('ANALYZE content_chunks');
    const metas: Array<Record<string, unknown>> = [];
    const capped = await engine.searchKeyword('席位 升级', { limit: 5, orFallback: true,
      cjkKeyword: { deadlineMs: 3000, candidateCap: 50, pgliteCappedChunks: 0, onMeta: (m) => metas.push(m as never) } });
    const full = await engine.searchKeyword('席位 升级', { limit: 5, orFallback: true });
    expect(slugs(capped)).toEqual(slugs(full));
    expect(metas[0]).toMatchObject({ incomplete: false, capped: true });
  });

  test('below the chunk threshold the full path runs and reports complete', async () => {
    await page('notes/both', '席位和升级');
    const metas: Array<Record<string, unknown>> = [];
    await engine.searchKeyword('席位 升级', { orFallback: true, cjkKeyword: { deadlineMs: 3000, onMeta: (m) => metas.push(m as never) } });
    expect(metas[0]).toMatchObject({ incomplete: false, capped: false });
    expect(typeof metas[0]?.arm_ms).toBe('number');
  });
});

describe('hybrid wiring (#5989)', () => {
  test('hybrid passes the deadline and turns an incomplete arm into keyword_candidates_incomplete with its arm time', async () => {
    const { hybridSearch } = await import('../src/core/search/hybrid.ts');
    await page('notes/both', '席位和升级');
    await engine.setConfig('embedding_disabled', 'true');
    const original = engine.searchKeyword.bind(engine);
    let seenDeadline: number | undefined;
    engine.searchKeyword = (async (q: string, opts?: Parameters<typeof original>[1]) => {
      seenDeadline = opts?.cjkKeyword?.deadlineMs;
      opts?.cjkKeyword?.onMeta?.({ incomplete: true, reason: 'timeout', capped: true, arm_ms: 1234 });
      return [];
    }) as typeof engine.searchKeyword;
    try {
      let meta: { degraded?: Array<{ stage: string; reason?: string }>; keyword_candidates?: unknown } | undefined;
      await hybridSearch(engine, '席位 升级', { onMeta: (m) => { meta = m as never; } });
      expect(seenDeadline).toBe(3000);
      expect(meta?.degraded).toContainEqual({ stage: 'keyword_candidates_incomplete', reason: 'timeout' });
      expect(meta?.keyword_candidates).toEqual({ incomplete: true, reason: 'timeout', capped: true, arm_ms: 1234 });
    } finally {
      engine.searchKeyword = original;
    }
  });
});
