/**
 * F2 plumbing: `search.long_page_unit` delivers long non-conversation hits in
 * an existing unit (`window`, `section`, `page`) under an implied `auto`, on
 * `search` and `query` only. Off (the default) is byte-identical to
 * `return_unit: "chunk"`; the on path is pinned by its own frozen golden
 * (test/fixtures/goldens/evidence-delivery/long-page-on-path.json).
 *
 * Long means a rendered body of at least `search.long_page_min_chars`
 * (default 20,000) characters. Precedence (docs/evidence-delivery.md "Long
 * pages"): explicit `return_unit` > non-`auto` `search.return_unit` >
 * `search.long_page_unit`; an explicit `token_budget` keeps it off. A widened
 * row is exempt from `snippet_chars`; every other row is cut. recall, think and
 * `assemble_evidence` never read it. Assertions are on the serialized lean
 * MCP output a remote agent receives. The Postgres arm is
 * test/e2e/evidence-long-page.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';
import {
  DEFAULT_LONG_PAGE_MIN_CHARS, LONG_PAGE_DEADLINE_MS, LONG_PAGE_MAX_INPUT_BYTES, LONG_PAGE_MAX_PAGES, assembleEvidenceForHits, deliverEvidence,
  longPageMinCharsValueProblem, longPageUnitValueProblem, pageEvidenceText, resolveEvidencePlan, selectLongPages, withLongPagePolicy, type EvidencePlan,
} from '../src/core/search/evidence-delivery.ts';
import { searchConfigValueRefusal } from '../src/core/search/config-values.ts';
import { leanRow } from '../src/core/search/lean-rows.ts';
import { runThink } from '../src/core/think/index.ts';
import { CONVERSATION_PAGE, DECIDING, LONG_SLUG, MEDIUM_SLUG, mcpCall, opCall, seedLongPages, withConfig } from './helpers/long-page-fixture.ts';

const GOLDEN = join(import.meta.dir, 'fixtures/goldens/evidence-delivery/long-page-on-path.json');
const KEY = 'search.long_page_unit';
const MIN_KEY = 'search.long_page_min_chars';
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedLongPages(engine);
}, 240_000);
afterAll(async () => { await engine?.disconnect(); }, 120_000);

const long = (rows: Array<Record<string, unknown>>) => rows.find(r => r.slug === LONG_SLUG)!;

describe('off path', () => {
  test('unset and `off` are byte-identical to return_unit chunk on search and query, with no delivery keys', async () => {
    for (const [name, params] of [['search', { query: 'renewal fee' }], ['query', { query: 'renewal fee', expand: false }]] as const) {
      const chunk = await mcpCall(engine, name, { ...params, return_unit: 'chunk' });
      const unset = await mcpCall(engine, name, params);
      const off = await withConfig(engine, { [KEY]: 'off' }, () => mcpCall(engine, name, params));
      expect(unset.bytes).toBe(chunk.bytes);
      expect(off.bytes).toBe(chunk.bytes);
      expect(unset.bytes).not.toContain('"delivered"');
      expect(unset.bytes).not.toContain('"delivery"');
    }
  });

  test('an unknown stored value reads as off; config set refuses it', async () => {
    const chunk = await mcpCall(engine, 'search', { query: 'renewal fee', return_unit: 'chunk' });
    expect((await withConfig(engine, { [KEY]: 'sentence' }, () => mcpCall(engine, 'search', { query: 'renewal fee' }))).bytes).toBe(chunk.bytes);
    expect(longPageUnitValueProblem('section')).toBeNull();
    expect(searchConfigValueRefusal(KEY, 'sentence')?.message).toContain('off, window, section, page');
    expect(longPageMinCharsValueProblem('20000')).toBeNull();
    for (const bad of ['0', '-5', '1.5', 'many']) expect(searchConfigValueRefusal(MIN_KEY, bad)?.message).toContain('positive whole number');
  });
});

describe('on path (serialized lean MCP output)', () => {
  test('replay: key section, default threshold: the long hit is widened to its section, every other hit keeps its ranked chunk', async () => {
    const stored = await engine.getPage(LONG_SLUG);
    expect(pageEvidenceText({ compiled_truth: stored!.compiled_truth, timeline: stored!.timeline ?? '' }, true).text.length).toBeGreaterThanOrEqual(DEFAULT_LONG_PAGE_MIN_CHARS);
    const medium = await engine.getPage(MEDIUM_SLUG);
    expect(new TextEncoder().encode(medium!.compiled_truth).length).toBeGreaterThan(8_000);
    expect(medium!.compiled_truth.length).toBeLessThan(DEFAULT_LONG_PAGE_MIN_CHARS);
    const off = await mcpCall(engine, 'search', { query: 'renewal fee' });
    const on = await withConfig(engine, { [KEY]: 'section' }, () => mcpCall(engine, 'search', { query: 'renewal fee' }));
    const payload = JSON.parse((JSON.parse(on.bytes) as { content: Array<{ text: string }> }).content[0].text) as Array<Record<string, unknown>>;
    expect(payload.map(r => r.slug)).toEqual(off.rows.map(r => r.slug));
    expect(payload.map(r => r.slug)).toEqual(expect.arrayContaining([LONG_SLUG, MEDIUM_SLUG, 'notes/short-example']));
    const row = long(payload);
    expect(row.delivered).toEqual({ unit: 'section', reason: 'long_page' });
    expect(String(row.chunk_text)).toContain(String(long(off.rows).chunk_text).slice(0, 120));
    expect(String(row.chunk_text).startsWith('## ')).toBe(true);
    expect(String(row.chunk_text).length).toBeLessThan(stored!.compiled_truth.length);
    expect(String(row.chunk_text)).not.toContain(DECIDING);
    for (const r of payload.filter(r => r.slug !== LONG_SLUG)) {
      expect(r.delivered).toBeUndefined();
      expect(JSON.stringify(r)).toBe(JSON.stringify(off.rows.find(o => o.slug === r.slug)));
    }
  });

  test('search.long_page_min_chars moves the line: at 5,000 the medium page is widened too', async () => {
    const on = await withConfig(engine, { [KEY]: 'section', [MIN_KEY]: '5000' }, () => mcpCall(engine, 'search', { query: 'renewal fee' }));
    expect(on.rows.find(r => r.slug === MEDIUM_SLUG)!.delivered).toEqual({ unit: 'section', reason: 'long_page' });
    expect(on.rows.find(r => r.slug === 'notes/short-example')!.delivered).toBeUndefined();
  });

  for (const unit of ['window', 'section', 'page'] as const) {
    test(`${unit}: the long row carries delivered {unit, reason}; short rows are their off-path bytes`, async () => {
      const off = await mcpCall(engine, 'search', { query: 'renewal fee' });
      const on = await withConfig(engine, { [KEY]: unit }, () => mcpCall(engine, 'search', { query: 'renewal fee' }));
      const row = long(on.rows);
      expect(row.delivered).toEqual({ unit, reason: 'long_page' });
      expect(String(row.chunk_text).length).toBeGreaterThan(String(long(off.rows).chunk_text).length);
      expect(on.rows.map(r => r.slug)).toEqual(off.rows.map(r => r.slug));
      for (const r of on.rows.filter(r => r.slug !== LONG_SLUG)) expect(JSON.stringify(r)).toBe(JSON.stringify(off.rows.find(o => o.slug === r.slug)));
    });
  }

  test('query delivers the same way', async () => {
    const on = await withConfig(engine, { [KEY]: 'section' }, () => mcpCall(engine, 'query', { query: 'renewal fee', expand: false }));
    expect(long(on.rows).delivered).toEqual({ unit: 'section', reason: 'long_page' });
  });

  test('term words that recur in non-deciding clauses: the unit is anchored on the ranked hit, never on term overlap', async () => {
    const off = long((await mcpCall(engine, 'search', { query: 'renewal fee' })).rows);
    const deliveredText = async (unit: string) => String(long((await withConfig(engine, { [KEY]: unit }, () => mcpCall(engine, 'search', { query: 'renewal fee' }))).rows).chunk_text);
    const section = await deliveredText('section');
    expect(section).toContain(String(off.chunk_text).slice(0, 120));
    expect(section).not.toContain(DECIDING);
    expect(section).not.toContain('## Term and renewal');
    expect(await deliveredText('page')).toContain(DECIDING);
  });

  test('frozen on-path golden', async () => {
    const got: Record<string, string> = {};
    for (const unit of ['window', 'section', 'page'] as const) {
      got[`mcp-search:${unit}`] = (await withConfig(engine, { [KEY]: unit }, () => mcpCall(engine, 'search', { query: 'renewal fee' }))).bytes;
    }
    if (process.env.GBRAIN_TEST_UPDATE_GOLDENS === '1') {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + '\n');
    }
    const want = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    for (const key of Object.keys(want)) expect(`${key}: ${got[key]}`).toBe(`${key}: ${want[key]}`);
  });

  test('a long page whose matching span no longer fits the budget keeps its ranked chunk (long_page_chunk)', async () => {
    const off = await mcpCall(engine, 'search', { query: 'renewal fee' });
    const on = await withConfig(engine, { [KEY]: 'section', 'search.return_budget_conversation': '40' }, () => mcpCall(engine, 'search', { query: 'renewal fee' }));
    const row = long(on.rows);
    expect(row.delivered).toEqual({ unit: 'chunk', reason: 'long_page_chunk' });
    expect(row.chunk_text).toBe(long(off.rows).chunk_text);
    expect((JSON.parse(on.bytes) as { _meta: { retrieval: { delivery: { fallbacks: string[] } } } })._meta.retrieval.delivery.fallbacks).toContain('long_page_over_budget');
  });
});

describe('on path with a conversation in the hit list', () => {
  let mixed: PGLiteEngine;
  beforeAll(async () => {
    mixed = new PGLiteEngine();
    await mixed.connect({});
    await mixed.initSchema();
    await seedLongPages(mixed);
    await seedLongPages(mixed, [CONVERSATION_PAGE]);
  }, 120_000);
  afterAll(async () => { await mixed?.disconnect(); }, 120_000);

  test('a conversation in the same hit list still comes back whole', async () => {
    const on = await withConfig(mixed, { [KEY]: 'section' }, () => opCall(mixed, 'search', { query: 'renewal fee' }));
    const rows = on.result as Array<SearchResult & { delivered: { unit: string; reason: string } }>;
    expect(rows.find(r => r.slug === CONVERSATION_PAGE.slug)!.delivered).toMatchObject({ unit: 'page', reason: 'conversation_slug' });
    expect(rows.find(r => r.slug === LONG_SLUG)!.delivered).toMatchObject({ unit: 'section', reason: 'long_page' });
    expect(rows.find(r => r.slug === 'notes/short-example')!.delivered).toMatchObject({ unit: 'chunk', reason: 'not_conversation' });
  });
});

describe('precedence', () => {
  const deliveredOf = async (config: Record<string, string>, params: Record<string, unknown>) =>
    withConfig(engine, config, async () => {
      const { result, meta } = await opCall(engine, 'search', { query: 'renewal fee', ...params });
      return { row: (result as Array<SearchResult & { delivered?: { unit: string; reason?: string } }>).find(r => r.slug === LONG_SLUG)!, meta };
    });

  test('a non-auto global search.return_unit wins: global window + long-page section delivers window everywhere', async () => {
    const { row } = await deliveredOf({ 'search.return_unit': 'window', [KEY]: 'section' }, {});
    expect(row.delivered?.unit).toBe('window');
    expect(row.delivered?.reason).toBeUndefined();
  });

  test('an explicit return_unit wins (chunk is the off path; auto keeps every non-conversation chunk)', async () => {
    const chunk = await mcpCall(engine, 'search', { query: 'renewal fee', return_unit: 'chunk' });
    expect((await withConfig(engine, { [KEY]: 'section' }, () => mcpCall(engine, 'search', { query: 'renewal fee', return_unit: 'chunk' }))).bytes).toBe(chunk.bytes);
    const { row } = await deliveredOf({ [KEY]: 'section' }, { return_unit: 'auto' });
    expect(row.delivered).toMatchObject({ unit: 'chunk', reason: 'not_conversation' });
    const page = await deliveredOf({ [KEY]: 'section' }, { return_unit: 'page' });
    expect(page.row.delivered?.unit).toBe('page');
    expect(page.row.delivered?.reason).toBeUndefined();
  });

  test('a config-level auto is still the implied auto: the key applies', async () => {
    const { row } = await deliveredOf({ 'search.return_unit': 'auto', [KEY]: 'section' }, {});
    expect(row.delivered).toMatchObject({ unit: 'section', reason: 'long_page' });
  });

  test('unchanged paths: with the key on, the cap path and explicit chunk/window units are byte-identical to the key off', async () => {
    for (const params of [{ token_budget: 4000 }, { return_unit: 'chunk' }, { return_unit: 'window' }]) {
      for (const name of ['search', 'query'] as const) {
        const call = { query: 'renewal fee', ...(name === 'query' ? { expand: false } : {}), ...params };
        const off = await mcpCall(engine, name, call);
        const on = await withConfig(engine, { [KEY]: 'section' }, () => mcpCall(engine, name, call));
        expect(`${name} ${JSON.stringify(params)}: ${on.bytes}`).toBe(`${name} ${JSON.stringify(params)}: ${off.bytes}`);
      }
    }
  });

  test('snippet_chars 300: the widened section survives whole and keeps delivered {unit, reason}; every other row is cut to 300 exactly as with the key off and marks delivered {truncated}', async () => {
    const off = await mcpCall(engine, 'search', { query: 'renewal fee', snippet_chars: 300 });
    const [on, full] = await withConfig(engine, { [KEY]: 'section' }, async () => [
      await mcpCall(engine, 'search', { query: 'renewal fee', snippet_chars: 300 }),
      await mcpCall(engine, 'search', { query: 'renewal fee' }),
    ]);
    const widened = long(on.rows);
    expect(widened.delivered).toEqual({ unit: 'section', reason: 'long_page' });
    expect(widened.chunk_text).toBe(long(full.rows).chunk_text);
    expect(String(widened.chunk_text).length).toBeGreaterThan(300);
    for (const r of on.rows.filter(r => r.slug !== LONG_SLUG)) {
      const { delivered, ...rest } = r;
      expect(JSON.stringify(rest)).toBe(JSON.stringify(off.rows.find(o => o.slug === r.slug)));
      expect(delivered).toEqual(String(r.chunk_text).includes('[truncated ') ? { truncated: true } : undefined);
    }
    expect(on.rows.some(r => r.slug !== LONG_SLUG && String(r.chunk_text).includes('[truncated '))).toBe(true);
    const zero = await withConfig(engine, { [KEY]: 'section' }, () => mcpCall(engine, 'search', { query: 'renewal fee', snippet_chars: 0 }));
    expect(long(zero.rows).chunk_text).toBe(long(full.rows).chunk_text);
  });
});

describe('other callers stay byte-identical with the key on', () => {
  test('recall, think and queryless assemble_evidence', async () => {
    const capture = async () => {
      const recall = (await mcpCall(engine, 'recall', { query: 'renewal fee' })).bytes;
      const page = await engine.getPage(LONG_SLUG);
      const [chunk] = await engine.executeRaw<{ id: number }>(`SELECT id FROM content_chunks WHERE page_id = $1 ORDER BY chunk_index LIMIT 1`, [page!.id]);
      const assembled = JSON.stringify(await assembleEvidenceForHits(engine, { hits: [{ source_id: 'default', slug: LONG_SLUG, chunk_id: chunk.id }], return_unit: 'auto', caller: { remote: true } }));
      const prompts: string[] = [];
      await runThink(engine, {
        question: 'renewal fee', remote: false, referenceDate: '2026-01-15',
        client: { create: async (params: { messages: unknown[] }) => {
          prompts.push(JSON.stringify(params.messages));
          return { content: [{ type: 'text', text: '{"answer":"ok","citations":[],"gaps":[]}' }], usage: { input_tokens: 1, output_tokens: 1 } };
        } } as never,
      });
      return { recall, assembled, think: prompts[0] };
    };
    const off = await capture();
    for (const unit of ['window', 'section', 'page']) expect(await withConfig(engine, { [KEY]: unit }, capture)).toEqual(off);
  });
});

describe('selection limits (size preflight)', () => {
  const plan = { requestedUnit: 'auto', unit: 'auto', window: 1, budgetTokens: 24000, explicitUnit: false, budgetExplicit: false, packing: 'cap_only', longPage: { unit: 'section', minChars: DEFAULT_LONG_PAGE_MIN_CHARS } } as EvidencePlan;
  const hit = (page_id: number, slug = `notes/p${page_id}`): SearchResult => ({ slug, page_id, title: slug, type: 'note', chunk_text: 'x', chunk_source: 'compiled_truth', chunk_id: page_id * 10, chunk_index: 0, score: 1, stale: false });
  const sized = (sizes: Record<number, number | [chars: number, bytes: number]>) => ({ executeRaw: async () => Object.entries(sizes).map(([id, v]) => ({ id: Number(id), chars: Array.isArray(v) ? v[0] : v, bytes: Array.isArray(v) ? v[1] : v })) }) as unknown as BrainEngine;

  test(`long means at least ${DEFAULT_LONG_PAGE_MIN_CHARS} characters, not bytes; no long page is effectivePlan exactly (null without a conversation)`, async () => {
    expect(await selectLongPages(sized({ 1: DEFAULT_LONG_PAGE_MIN_CHARS - 1 }), plan, [hit(1)], {})).toEqual({ plan: null });
    expect(await selectLongPages(sized({ 1: [DEFAULT_LONG_PAGE_MIN_CHARS - 1, DEFAULT_LONG_PAGE_MIN_CHARS * 3] }), plan, [hit(1)], {})).toEqual({ plan: null });
    const at = await selectLongPages(sized({ 1: DEFAULT_LONG_PAGE_MIN_CHARS }), plan, [hit(1)], {});
    expect([...at.longPages!.pages]).toEqual([1]);
    expect(at.longPages!.minChars).toBe(DEFAULT_LONG_PAGE_MIN_CHARS);
  });

  test(`at most ${LONG_PAGE_MAX_PAGES} pages, in rank order; later long pages keep their chunk`, async () => {
    const ids = Array.from({ length: LONG_PAGE_MAX_PAGES + 2 }, (_, i) => i + 1);
    const sel = await selectLongPages(sized(Object.fromEntries(ids.map(id => [id, 25_000]))), plan, ids.map(id => hit(id)), {});
    expect([...sel.longPages!.pages]).toEqual(ids.slice(0, LONG_PAGE_MAX_PAGES));
    expect([...sel.longPages!.kept]).toEqual(ids.slice(LONG_PAGE_MAX_PAGES).map(id => [id, 'long_page_pages']));
  });

  test(`at most ${LONG_PAGE_MAX_INPUT_BYTES} body bytes; a page that would cross it is never sliced, it keeps its chunk`, async () => {
    const half = Math.floor(LONG_PAGE_MAX_INPUT_BYTES * 0.6);
    const sel = await selectLongPages(sized({ 1: half, 2: half, 3: 25_000 }), plan, [hit(1), hit(2), hit(3)], {});
    expect([...sel.longPages!.pages]).toEqual([1, 3]);
    expect([...sel.longPages!.kept]).toEqual([[2, 'long_page_bytes']]);
  });

  test('conversation and saved-fact hits are never preflighted', async () => {
    let asked: unknown[] = [];
    const spy = { executeRaw: async (_sql: string, params: unknown[]) => { asked = params[0] as unknown[]; return []; } } as unknown as BrainEngine;
    await selectLongPages(spy, plan, [hit(1, 'chat/a'), { ...hit(2), fact_row: { id: 1, valid_from: '2026-01-01', valid_until: null } }, hit(3)], {});
    expect(asked).toEqual([3]);
  });

  test('a late preflight is the off path; with a conversation hit it is reported as long_page_deadline', async () => {
    const hanging = { executeRaw: () => new Promise(() => {}) } as unknown as BrainEngine;
    expect(await selectLongPages(hanging, plan, [hit(1)], {})).toEqual({ plan: null });
    const mixed = await selectLongPages(hanging, plan, [hit(1), hit(2, 'chat/a')], {});
    expect(mixed.plan).toBe(plan);
    expect(mixed.longPages?.fallbacks).toEqual(['long_page_deadline']);
  }, LONG_PAGE_DEADLINE_MS * 3 + 5_000);

  test('the policy is resolved only under an implied auto, with no explicit budget; snippet_chars does not turn it off', async () => {
    const resolve = async (input: Record<string, unknown>, config: Record<string, string> = {}) => withConfig(engine, { [KEY]: 'page', ...config }, async () =>
      (await withLongPagePolicy(engine, await resolveEvidencePlan(engine, { remote: true, returnUnit: input.return_unit, returnWindow: undefined, budget: input.token_budget, snippetChars: input.snippet_chars, snippetCap: 0, op: 'search' })))?.longPage ?? null);
    expect(await resolve({})).toEqual({ unit: 'page', minChars: DEFAULT_LONG_PAGE_MIN_CHARS });
    expect(await resolve({}, { [MIN_KEY]: '5000' })).toEqual({ unit: 'page', minChars: 5000 });
    expect(await resolve({}, { [MIN_KEY]: 'lots' })).toEqual({ unit: 'page', minChars: DEFAULT_LONG_PAGE_MIN_CHARS });
    expect(await resolve({ snippet_chars: 0 })).toEqual({ unit: 'page', minChars: DEFAULT_LONG_PAGE_MIN_CHARS });
    expect(await resolve({ return_unit: 'auto' })).toBeNull();
    expect(await resolve({ token_budget: 2000 })).toBeNull();
    expect(await resolve({ snippet_chars: 200 })).toEqual({ unit: 'page', minChars: DEFAULT_LONG_PAGE_MIN_CHARS });
    expect(await resolve({}, { 'search.return_unit': 'section' })).toBeNull();
  });

  test('a failed long-page fetch keeps the ranked chunks (long_page_fetch_failed), never the conversation fetch', async () => {
    const page = await engine.getPage(LONG_SLUG);
    const rows = await engine.executeRaw<{ id: number; chunk_index: number; chunk_text: string }>(`SELECT id, chunk_index, chunk_text FROM content_chunks WHERE page_id = $1 ORDER BY chunk_index LIMIT 1`, [page!.id]);
    const h: SearchResult = { slug: LONG_SLUG, page_id: page!.id, title: LONG_SLUG, type: 'note', chunk_text: rows[0].chunk_text, chunk_source: 'compiled_truth', chunk_id: rows[0].id, chunk_index: 0, score: 1, stale: false };
    const failing = new Proxy(engine, { get: (t, k) => k === 'getChunkWindows' ? async () => { throw new Error('boom'); } : (t as never)[k] }) as BrainEngine;
    const { results, delivery } = await deliverEvidence(failing, [h], plan, {}, { longPages: { unit: 'section', minChars: DEFAULT_LONG_PAGE_MIN_CHARS, pages: new Set([page!.id]), kept: new Map(), deadlineAt: Date.now() + 1000, fallbacks: [] } });
    expect(results[0].chunk_text).toBe(h.chunk_text);
    expect(results[0].delivered).toMatchObject({ unit: 'chunk', reason: 'long_page_chunk' });
    expect(delivery.fallbacks).toEqual(expect.arrayContaining(['long_page_fetch_failed']));
    expect(delivery.applied_unit).toBe('auto');
    expect(leanRow(results[0] as never).delivered).toEqual({ unit: 'chunk', reason: 'long_page_chunk' });
  });
});

describe('rendered-body confirmation', () => {
  test('a page the preflight passed but whose rendered body is under the threshold keeps its ranked chunk, with no fallback', async () => {
    const page = await engine.getPage(MEDIUM_SLUG);
    const [c] = await engine.executeRaw<{ id: number; chunk_index: number; chunk_text: string }>(`SELECT id, chunk_index, chunk_text FROM content_chunks WHERE page_id = $1 ORDER BY chunk_index LIMIT 1`, [page!.id]);
    const h: SearchResult = { slug: MEDIUM_SLUG, page_id: page!.id, title: MEDIUM_SLUG, type: 'note', chunk_text: c.chunk_text, chunk_source: 'compiled_truth', chunk_id: c.id, chunk_index: c.chunk_index, score: 1, stale: false };
    const plan = { requestedUnit: 'auto', unit: 'auto', window: 1, budgetTokens: 24000, explicitUnit: false, budgetExplicit: false, packing: 'cap_only' } as EvidencePlan;
    const { results, delivery } = await deliverEvidence(engine, [h], plan, {}, { longPages: { unit: 'section', minChars: DEFAULT_LONG_PAGE_MIN_CHARS, pages: new Set([page!.id]), kept: new Map(), deadlineAt: Date.now() + 1000, fallbacks: [] } });
    expect(results[0].chunk_text).toBe(h.chunk_text);
    expect(results[0].delivered).toMatchObject({ unit: 'chunk', reason: 'not_conversation' });
    expect(delivery.fallbacks.filter(f => f.startsWith('long_page'))).toEqual([]);
  });
});

describe('lean rows', () => {
  test('keep {truncated: true} alone for every other row, and {unit, reason, truncated?} for long-page rows', () => {
    const base = { slug: 'a', chunk_text: 't' };
    expect(leanRow({ ...base, delivered: { unit: 'page', truncated: true, reason: 'conversation_type' } }).delivered).toEqual({ truncated: true });
    expect(leanRow({ ...base, delivered: { unit: 'chunk', truncated: false, reason: 'not_conversation' } }).delivered).toBeUndefined();
    expect(leanRow({ ...base, delivered: { unit: 'section', truncated: true, reason: 'long_page' } }).delivered).toEqual({ unit: 'section', reason: 'long_page', truncated: true });
    expect(leanRow({ ...base, delivered: { unit: 'window', truncated: false, reason: 'long_page' } }).delivered).toEqual({ unit: 'window', reason: 'long_page' });
  });
});
