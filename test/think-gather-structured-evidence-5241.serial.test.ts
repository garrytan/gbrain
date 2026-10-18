import { beforeEach, expect, mock, test } from 'bun:test';
import type { SearchResult, Page } from '../src/core/types.ts';
import type { BrainEngine } from '../src/core/engine.ts';
let hybrid: SearchResult[] = [];
let floor: Page[] = [];
let seenHybrid: any;
let seenFloor: any;
let failFloor = false;
mock.module('../src/core/search/hybrid.ts', () => ({ hybridSearch: async (_e: unknown, _q: string, opts: unknown) => { seenHybrid = opts; return hybrid; } }));
mock.module('../src/core/eligibility/labels.ts', () => ({ EXTERNAL_DATA_RULE: '', needsDataEnvelope: () => false, trustAttributes: () => '' }));
mock.module('../src/core/search/expansion.ts', () => ({ sanitizeQueryForPrompt: (s: string) => s }));
mock.module('../src/core/page-window/document.ts', () => ({ boundedProjectedPrefix: (s: string) => s }));
mock.module('../src/core/page-window/bounded-lead.ts', () => ({
  pageLeadSource: async (_e: unknown, p: Page) => p.compiled_truth,
  overlaidBoundedRows: async (_e: unknown, rows: unknown[]) => rows,
}));
const { runGather } = await import('../src/core/think/gather.ts');
const day = '2026-07-18T12:00:00.000Z';
const window = { startMs: Date.parse('2026-07-01'), endMs: Date.parse('2026-07-31') };
const hit = (slug: string, source_id = 'default', dated = false): SearchResult => ({ slug, page_id: 0, source_id, title: slug, type: 'note', chunk_text: 'synthetic', score: 1, stale: false, chunk_id: 0, chunk_index: 0, chunk_source: 'compiled_truth', effective_date: dated ? day : null });
const page = (slug: string, source_id = 'default'): Page => ({ slug, source_id, id: 1, title: slug, type: 'note', compiled_truth: 'synthetic', effective_date: new Date(day) } as Page);
const engine = {
 listPages: async (opts: unknown) => { seenFloor = opts; if (failFloor) throw new Error('synthetic unavailable'); return floor; },
 searchTakes: async () => [],
} as unknown as BrainEngine;
const gather = (limit = 8, withWindow = true) => runGather(engine, { question: 'synthetic', gatherLimit: limit, remote: true, sourceIds: ['default', 'mail'], excludePrivate: true, ...(withWindow ? { window } : {}) });
beforeEach(() => { hybrid = []; floor = []; seenHybrid = undefined; seenFloor = undefined; failFloor = false; });
test('saturated hybrid retains a real floor miss and dated hybrid tail beyond floor sample', async () => {
 hybrid = Array.from({length: 12}, (_, i) => hit(`notes/${i}`, 'default', i === 10)); floor = [page('calendar/event', 'mail')];
 const r = await gather(); expect(r.pages).toHaveLength(8); expect(r.pages.map(p => p.slug)).toContain('calendar/event'); expect(r.pages.map(p => p.slug)).toContain('notes/10');
});
test('source-qualified same-slug floor evidence survives', async () => {
 hybrid = Array.from({length: 12}, (_, i) => hit(`notes/${i}`)); floor = [page('notes/0', 'mail')];
 const r = await gather(); expect(r.pages.filter(p => p.slug === 'notes/0').map(p => p.source_id).sort()).toEqual(['default', 'mail']);
});
test('under-return fills to the cap without changing per-stream order', async () => {
 hybrid = [hit('a')]; floor = Array.from({length: 12}, (_, i) => page(`f/${i}`));
 expect((await gather()).pages.map(p => p.slug)).toEqual(['a', 'f/0', 'f/1', 'f/2', 'f/3', 'f/4', 'f/5', 'f/6']);
});
test('no floor miss keeps pure hybrid ordering', async () => {
 hybrid = Array.from({length: 12}, (_, i) => hit(`notes/${i}`, 'default', i === 10)); floor = [page('notes/10')];
 expect((await gather()).pages.map(p => p.slug)).toEqual(hybrid.slice(0, 8).map(p => p.slug));
});
test('small zero-reserve limits stay exact', async () => {
 hybrid = [hit('a'), hit('b')]; floor = [page('f')]; expect((await gather(1)).pages.map(p => p.slug)).toEqual(['a']);
});
test('window excludes dated out-of-window floor evidence', async () => {
 hybrid = [hit('a')]; floor = [page('old')]; floor[0].effective_date = new Date('2025-01-01'); expect((await gather()).pages.map(p => p.slug)).toEqual(['a']);
});
test('both legs disable token packing while preserving breadth and scoped filter options', async () => {
 await gather(); expect(seenHybrid.tokenBudget).toBe(0); expect(seenHybrid.autocut).toBe(false); expect(seenHybrid.adaptiveReturn).toBe(false);
 expect(seenHybrid.sourceIds).toEqual(['default', 'mail']); expect(seenFloor.sourceIds).toEqual(['default', 'mail']); expect(seenFloor.excludePrivate).toBe(true); expect(seenFloor.requireSafeChunks).toBe(true);
 await gather(8, false); expect(seenHybrid.tokenBudget).toBe(0);
});
test('floor failure retains warning and available hybrid evidence', async () => {
 hybrid = [hit('a')]; failFloor = true; const r = await gather(); expect(r.pages.map(p => p.slug)).toEqual(['a']); expect(r.warnings).toContain('GATHER_WINDOW_FLOOR_FAILED');
});
