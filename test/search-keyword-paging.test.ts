/**
 * Cat 40 Hard F2: honest keyword counts and exhaustive keyword paging on
 * `search` (PGLite; the engine-level walks run on Postgres too in
 * test/e2e/search-keyword-paging-parity.test.ts).
 *
 * Pins: `keyword_total` on the default hybrid path counts the strict keyword
 * match set (never the OR retry); `match: "keyword"` walks every page that
 * `total` reports, past 3 x limit, with a dominant page of hundreds of
 * matching chunks, mixed types and a write mid-walk; `total` / `truncated` /
 * `next` at page boundaries; every enumerated page keeps a row under a small
 * evidence budget; the refusals (remote `mode`, cursor outside keyword mode,
 * offset over 10,000) and the unavailable count; the model-visible line read
 * from MCP content blocks only (never `_meta`); private fence text and
 * private pages are not counted for remote callers. The 10,000 cap is in
 * test/search-keyword-cap.slow.test.ts.
 *
 * Authoring gate: (1) protects the count and paging contract agents read in
 * MCP text; (2) fails if the count reads the OR retry or a capped pool, if a
 * page with many chunks crowds others out, if evidence delivery drops an
 * enumerated page, or if a refusal loses its fix; (3) no existing test covers
 * keyword counts or keyword-mode paging (new surface); (4) no new seam: the
 * unavailable-count tests wrap the real engine.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { errorCodeRow } from '../src/core/error-docs.ts';
import { countKeywordMatches, searchCountLine } from '../src/core/search/keyword-paging.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  DOMINANT_CHUNKS, DOMINANT_SLUG, MANY_PAGES, MIXED_TYPES, TERM, callSearch, seedKeywordCorpus, seedPage, walkKeyword,
} from './helpers/keyword-paging-fixture.ts';

const REMOTE = { remote: true, transport: 'http' as const, sourceId: 'default' };

let engine: PGLiteEngine;
let matching: string[];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  matching = await seedKeywordCorpus(engine);
}, 180_000);

afterAll(async () => { await engine?.disconnect(); });

/** Every text block an agent sees, never `_meta`. */
const visible = (res: ToolResult) => res.content.map(c => c.text);
const countLine = (res: ToolResult) => visible(res).find(t => t.startsWith('[gbrain search] ')) ?? '';
const mcp = (args: Record<string, unknown>) => withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'search', args, REMOTE));
/** The `next` object exactly as the model reads it from the count line. */
const nextFromLine = (line: string) => {
  const at = line.indexOf('next = ');
  return at < 0 ? undefined : JSON.parse(line.slice(at + 'next = '.length)) as Record<string, unknown>;
};

describe('engine: strict keyword pages', () => {
  test('the dominant page has hundreds of matching chunks', async () => {
    const [{ n }] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = $1`, [DOMINANT_SLUG]);
    expect(Number(n)).toBeGreaterThanOrEqual(DOMINANT_CHUNKS);
  });

  test('count is distinct pages, equal to what searchKeyword finds with room to spare', async () => {
    const total = await engine.countKeywordPages(TERM, { requireSafeChunks: true });
    expect(total).toBe(matching.length);
    expect(total).toBe(1 + MANY_PAGES + MIXED_TYPES);
  });

  test('a query only the OR retry matches counts 0 and pages nothing', async () => {
    const relaxed = await engine.searchKeyword('zephyrine obsidianite', { orFallback: true });
    expect(relaxed.length).toBe(2);
    expect(await engine.countKeywordPages('zephyrine obsidianite')).toBe(0);
    expect(await engine.searchKeywordPages('zephyrine obsidianite', undefined, { limit: 10 })).toEqual([]);
  });
});

describe('match: "keyword" walk', () => {
  test('pages past 3 x limit and recovers every page total reports, the dominant page once', async () => {
    const limit = 5;
    const { pages, slugs } = await walkKeyword(engine, { query: TERM, limit });
    expect(pages.length).toBeGreaterThan(3);
    expect(pages[0].retrieval.total).toBe(matching.length);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect([...slugs].sort()).toEqual([...matching].sort());
    expect(slugs.filter(s => s === DOMINANT_SLUG).length).toBe(1);
    for (const [i, page] of pages.entries()) {
      expect(page.retrieval.truncated).toBe(i < pages.length - 1);
      expect('next' in page.retrieval).toBe(i < pages.length - 1);
      expect(page.retrieval.shown_from).toBe(i * limit + 1);
    }
  });

  test('order is keyword score, then page id', async () => {
    const { pages } = await walkKeyword(engine, { query: TERM, limit: 7 }, false);
    const rows = pages.flatMap(p => p.rows) as Array<{ score: number; page_id: number }>;
    for (let i = 1; i < rows.length; i++) {
      const [a, b] = [rows[i - 1], rows[i]];
      expect(a.score > b.score || (a.score === b.score && a.page_id < b.page_id)).toBe(true);
    }
  });

  test('page boundaries: total a multiple of limit ends with truncated false and no next', async () => {
    const limit = matching.length / 4;
    expect(Number.isInteger(limit)).toBe(true);
    const { pages } = await walkKeyword(engine, { query: TERM, limit });
    expect(pages.length).toBe(4);
    expect(pages[3].rows.length).toBe(limit);
    expect(pages[3].retrieval.truncated).toBe(false);
    expect(pages[3].retrieval.next).toBeUndefined();
    const one = await walkKeyword(engine, { query: TERM, limit: matching.length - 1 });
    expect(one.pages.map(p => p.rows.length)).toEqual([matching.length - 1, 1]);
    const all = await callSearch(engine, { query: TERM, match: 'keyword', limit: matching.length });
    expect(all.retrieval).toMatchObject({ total: matching.length, truncated: false });
    expect(all.retrieval.next).toBeUndefined();
  });

  test('offset paging matches cursor paging and an offset past the end is an empty page', async () => {
    const byCursor = (await walkKeyword(engine, { query: TERM, limit: 6 })).slugs;
    const byOffset: string[] = [];
    for (let offset = 0; offset < matching.length; offset += 6) {
      byOffset.push(...(await callSearch(engine, { query: TERM, match: 'keyword', limit: 6, offset })).rows.map(r => String(r.slug)));
    }
    expect(byOffset).toEqual(byCursor);
    const past = await callSearch(engine, { query: TERM, match: 'keyword', offset: 500 });
    expect(past.rows).toEqual([]);
    expect(past.retrieval).toMatchObject({ total: matching.length, truncated: false });
  });

  test('mixed types: a type filter counts and walks only that type', async () => {
    const { pages, slugs } = await walkKeyword(engine, { query: TERM, limit: 3, types: ['meeting'] });
    expect(pages[0].retrieval.total).toBe(MIXED_TYPES);
    expect(slugs.every(s => s.startsWith('meetings/'))).toBe(true);
    expect(slugs.length).toBe(MIXED_TYPES);
    const unfiltered = await walkKeyword(engine, { query: TERM, limit: 50 });
    expect(new Set(unfiltered.pages.flatMap(p => p.rows.map(r => r.type)))).toEqual(new Set(['note', 'meeting']));
  });

  test('a write landing mid-walk never repeats a page or loses an unchanged one', async () => {
    const before = new Set(matching);
    const { slugs } = await walkKeyword(engine, { query: TERM, limit: 4 }, true, 50, async page => {
      if (page === 2) await seedPage(engine, 'notes/zz-late-arrival', `A late ${TERM} note.`);
    });
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of before) expect(slugs).toContain(slug);
    await engine.executeRaw(`DELETE FROM pages WHERE slug = 'notes/zz-late-arrival'`);
  });

  test('a cursor is bound to its query', async () => {
    const first = await callSearch(engine, { query: TERM, match: 'keyword', limit: 3 });
    const next = first.retrieval.next as Record<string, unknown>;
    await expect(callSearch(engine, { ...next, query: 'rollout' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(callSearch(engine, { ...next, cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('MCP: model-visible counts and paging (content blocks only, no _meta)', () => {
  test('hybrid search carries one count line after the rows', async () => {
    const res = await mcp({ query: TERM, limit: 3 });
    expect(JSON.parse(res.content[0].text).length).toBeGreaterThan(0);
    const line = countLine(res);
    expect(line).toBe(`[gbrain search] Rows are a ranked top-K, not proof of coverage. Keyword matches: ${matching.length} pages (pages matching the query's keywords, not a count of these rows). List every keyword match with match: "keyword".`);
    expect(visible(res).filter(t => t.startsWith('[gbrain search] ')).length).toBe(1);
    expect(visible(res).indexOf(line)).toBe(1);
  });

  test('empty results: hybrid and keyword mode still say what was counted', async () => {
    const hybrid = await mcp({ query: 'nonexistentterm' });
    expect(JSON.parse(hybrid.content[0].text)).toEqual([]);
    expect(countLine(hybrid)).toContain('Keyword matches: 0 pages');
    const keyword = await mcp({ query: 'nonexistentterm', match: 'keyword' });
    expect(JSON.parse(keyword.content[0].text)).toEqual([]);
    expect(countLine(keyword)).toBe('[gbrain search] Keyword matches: 0 pages; none on this page. No more keyword matches.');
  });

  test('a keyword walk driven only by the visible next recovers every page', async () => {
    const seen: string[] = [];
    let args: Record<string, unknown> | undefined = { query: TERM, match: 'keyword', limit: 4 };
    let first = '';
    while (args) {
      const res = await mcp(args);
      expect(res.isError).toBeUndefined();
      seen.push(...(JSON.parse(res.content[0].text) as Array<{ slug: string }>).map(r => r.slug));
      first ||= countLine(res);
      args = nextFromLine(countLine(res));
    }
    expect(first).toStartWith(`[gbrain search] Keyword matches: ${matching.length} pages; showing 1-4, keyword-score order. More: call search with next = {`);
    expect([...seen].sort()).toEqual([...matching].sort());
  });

  test('small token budgets and oversized pages: every enumerated page keeps a row, next continues after it', async () => {
    await seedPage(engine, 'meetings/zz-oversized', `${`The ${TERM} review ran long. `.repeat(400)}`, { type: 'meeting' });
    try {
      const args = { query: TERM, match: 'keyword', types: ['meeting'], return_unit: 'page', token_budget: 40, limit: 3 };
      const seen: Array<{ slug: string; evidence_omitted?: boolean; chunk_text: string }> = [];
      let next: Record<string, unknown> | undefined = args;
      let omittedLine = '';
      while (next) {
        const res = await mcp(next);
        const rows = JSON.parse(res.content[0].text) as typeof seen;
        expect(rows.length).toBeGreaterThan(0);
        seen.push(...rows);
        if (rows.some(r => r.evidence_omitted)) omittedLine = countLine(res);
        next = nextFromLine(countLine(res));
      }
      expect(seen.map(r => r.slug).sort()).toEqual([...matching.filter(s => s.startsWith('meetings/')), 'meetings/zz-oversized'].sort());
      expect(seen.some(r => r.evidence_omitted === true && r.chunk_text === '')).toBe(true);
      expect(omittedLine).toContain('evidence_omitted: true');
    } finally {
      await engine.executeRaw(`DELETE FROM pages WHERE slug = 'meetings/zz-oversized'`);
    }
  });

  test('short, oversized, short: the oversized middle page keeps its row in order', async () => {
    await seedPage(engine, 'meetings/sos-1', `${TERM} ${TERM} ${TERM} sos short one.`, { type: 'meeting' });
    await seedPage(engine, 'meetings/sos-2', `${TERM} sos oversized middle. ${'Filler sentence about logistics planning. '.repeat(400)}`, { type: 'meeting' });
    await seedPage(engine, 'meetings/sos-3', `${TERM} sos short three.`, { type: 'meeting' });
    try {
      const keyword = await callSearch(engine, { query: `${TERM} sos`, match: 'keyword', types: ['meeting'] });
      const order = keyword.rows.map(r => String(r.slug));
      const res = await mcp({ query: `${TERM} sos`, match: 'keyword', types: ['meeting'], return_unit: 'page', token_budget: 60 });
      const rows = JSON.parse(res.content[0].text) as Array<{ slug: string; evidence_omitted?: boolean }>;
      expect(rows.map(r => r.slug)).toEqual(order);
      expect(rows.length).toBe(3);
      expect(order).toEqual(['meetings/sos-1', 'meetings/sos-2', 'meetings/sos-3']);
      expect(rows.filter(r => r.evidence_omitted).map(r => r.slug)).toEqual(['meetings/sos-2']);
    } finally {
      await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'meetings/sos-%'`);
    }
  });

  test('repeated chunks: one row per page', async () => {
    const res = await mcp({ query: TERM, match: 'keyword', limit: 50 });
    const slugs = (JSON.parse(res.content[0].text) as Array<{ slug: string }>).map(r => r.slug);
    expect(slugs.filter(s => s === DOMINANT_SLUG).length).toBe(1);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('remote callers may pass match; mode stays local-only and its refusal points to match: "keyword"', async () => {
    const ok = await mcp({ query: TERM, match: 'keyword', limit: 2 });
    expect(ok.isError).toBeUndefined();
    expect(visible(ok).some(t => t.includes('unknown_param'))).toBe(false);
    const refused = await mcp({ query: TERM, mode: 'keyword' });
    expect(refused.isError).toBe(true);
    const body = JSON.parse(refused.content[0].text);
    expect(body.code).toBe('search_mode_local_only');
    expect(body.message).toBe("search: mode is set by the brain's operator and cannot be chosen per call.");
    expect(body.suggestion).toBe('Omit mode. For keyword-only matching with a total and a next page, pass match: "keyword".');
    const local = await callSearch(engine, { query: TERM, mode: 'balanced', limit: 2 }, false);
    expect(local.rows.length).toBeGreaterThan(0);
  });

  test('a cursor outside keyword mode and an offset over 10,000 are refused with the fix named', async () => {
    const first = await callSearch(engine, { query: TERM, match: 'keyword', limit: 2 });
    const { match: _m, ...hybrid } = first.retrieval.next as Record<string, unknown>;
    const res = await mcp(hybrid);
    const body = JSON.parse(res.content[0].text);
    expect(body.code).toBe('search_cursor_requires_keyword');
    expect(body.message).toBe('search: cursor continues a match: "keyword" listing; this call is hybrid.');
    expect(body.suggestion).toBe('Send the next object from the previous response unchanged (it carries match: "keyword"). Hybrid rows are a ranked top-K with no next page.');
    const deep = JSON.parse((await mcp({ query: TERM, offset: 10_001 })).content[0].text);
    expect(deep.code).toBe('search_offset_over_cap');
    expect(deep.message).toBe('search: offset 10001 is over the 10,000 limit.');
    expect(deep.suggestion).toBe('Page with match: "keyword" and send the next object each response returns; a cursor has no depth limit.');
    const hybridOffset = await mcp({ query: TERM, offset: 2, limit: 2 });
    expect(hybridOffset.isError).toBeUndefined();
  });

  test('every new code is in the gbrain errors catalogue', () => {
    for (const code of ['search_cursor_requires_keyword', 'search_mode_local_only', 'search_offset_over_cap']) {
      expect(errorCodeRow(code)?.class).toBe('caller');
    }
  });
});

describe('count unavailable: a degraded stage, never a number', () => {
  const stalled = (base: BrainEngine, how: 'hang' | 'timeout'): BrainEngine => new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'countKeywordPages') {
        return how === 'hang' ? () => new Promise(() => {}) : async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  test('a count past its deadline is unavailable', async () => {
    expect(await countKeywordMatches(stalled(engine, 'hang'), TERM, {}, 50)).toEqual({ unavailable: 'timeout' });
    expect(await countKeywordMatches(stalled(engine, 'timeout'), TERM, {}, 1000)).toEqual({ unavailable: 'timeout' });
  });

  test('over MCP: the line says unavailable, the stage is recorded, keyword paging still works', async () => {
    const e = stalled(engine, 'timeout');
    const hybrid = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(e, 'search', { query: TERM }, REMOTE));
    expect(countLine(hybrid)).toContain('Keyword match count unavailable (timed out; not a count of zero)');
    expect((hybrid._meta as { retrieval: { degraded: unknown[] } }).retrieval.degraded).toContainEqual({ stage: 'keyword_count_unavailable', reason: 'timeout' });
    const keyword = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(e, 'search', { query: TERM, match: 'keyword', limit: 3 }, REMOTE));
    expect(countLine(keyword)).toStartWith('[gbrain search] Keyword match count unavailable (timed out; not a count of zero); showing 1-3');
    expect(nextFromLine(countLine(keyword))).toBeDefined();
  });

  test('the line renderer never invents a number', () => {
    expect(searchCountLine([], { keyword_total: null, degraded: [{ stage: 'keyword_count_unavailable' }] }))
      .toContain('Keyword match count unavailable (failed; not a count of zero)');
    expect(searchCountLine([], { returned_count: 0 })).toBeNull();
  });
});

describe('visibility: untrusted callers never count private text', () => {
  test('private takes/facts fence text and private pages are not counted', async () => {
    const fenced = 'Public body.\n<!--- gbrain:takes:begin -->\nThe marmoset deal is risky.\n<!--- gbrain:takes:end -->';
    await seedPage(engine, 'notes/fenced', fenced);
    await seedPage(engine, 'notes/private-marmoset', 'The marmoset memo.', { frontmatter: { visibility: 'private' } });
    try {
      const remote = await callSearch(engine, { query: 'marmoset' }, true);
      expect(remote.retrieval.keyword_total).toBe(0);
      const remoteKeyword = await callSearch(engine, { query: 'marmoset', match: 'keyword' }, true);
      expect(remoteKeyword.retrieval.total).toBe(0);
      expect(remoteKeyword.rows).toEqual([]);
      const local = await callSearch(engine, { query: 'marmoset' }, false);
      expect(local.retrieval.keyword_total).toBe(1);
    } finally {
      await engine.executeRaw(`DELETE FROM pages WHERE slug IN ('notes/fenced', 'notes/private-marmoset')`);
    }
  });
});
