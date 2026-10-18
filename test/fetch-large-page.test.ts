/**
 * Large pages (Wave A, T24): the search/fetch-only surface reads a page too
 * large to send whole. A search result id names the hit's chunk, so fetch
 * returns that evidence rather than the first window; metadata.next_id reads
 * on to the end; stale anchors still finish the page. Hermetic PGLite.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { pageDocument } from '../src/core/page-window/document.ts';
import { decodeDeepResearchAnchor, decodeDeepResearchId, encodeDeepResearchId } from '../src/core/deep-research-id.ts';

let engine: PGLiteEngine;
const fetchOp = operations.find(o => o.name === 'fetch')!;
const searchOp = operations.find(o => o.name === 'search')!;
const ctx = (): OperationContext => ({ engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false,
  remote: true, transport: 'http', sourceId: 'default', auth: { allowedSources: ['default'] } } as unknown as OperationContext);
const fetch = async (id: string) => await fetchOp.handler(ctx(), { id }) as Record<string, any>;

function log(lines: number, marker: (i: number) => string = () => ''): string {
  return ['# Planning log', '', ...Array.from({ length: lines }, (_, i) => `- 2026-05-${String(1 + (i % 28)).padStart(2, '0')} entry ${i} about the acme-example widget plan${marker(i)}`)].join('\n');
}
async function put(slug: string, body: string) {
  const r = await importFromContent(engine, slug, serializeMarkdown({}, body, '', { type: 'note', title: slug, tags: [] }), { sourceId: 'default', noEmbed: true, forceRechunk: true });
  expect(r.status).toBe('imported');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('search.mcp_keyword_only', 'true');
  await put('notes/long-example', log(6000, i => (i === 5800 ? ' quasarneedle deep hit' : '')));
  await put('notes/short-example', 'A short page about quasarneedle short.');
}, 120_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);

describe('fetch on a large page', () => {
  test('a deep search hit fetches its own evidence, not the first window', async () => {
    const hits = await searchOp.handler(ctx(), { query: 'quasarneedle deep' }) as any[];
    const hit = hits.find(h => h.slug === 'notes/long-example');
    expect(hit).toBeDefined();
    expect(decodeDeepResearchId(hit.id)).toEqual({ sourceId: 'default', slug: 'notes/long-example' });
    expect(decodeDeepResearchAnchor(hit.id)).toEqual({ chunkId: hit.chunk_id });
    const page = await fetch(hit.id);
    expect(page.id).toBe(hit.id);
    expect(page.text).toContain('quasarneedle deep hit');
    expect(page.metadata.anchor).toBe('chunk');
    expect(page.metadata.truncated).toBe(true);
    expect(page.metadata.window.byte_start).toBeGreaterThan(page.metadata.total_bytes / 2);
    expect(page.url).toBe('gbrain://page/default/notes/long-example');
  }, 60_000);

  test('next_id pages the whole read projection, in order, using only fetch', async () => {
    const snap = await engine.readPageSnapshot('notes/long-example', { sourceId: 'default' });
    const doc = pageDocument({ compiled_truth: snap!.page.compiled_truth, timeline: snap!.page.timeline }).bytes;
    const parts: string[] = [];
    let page = await fetch(encodeDeepResearchId('default', 'notes/long-example'));
    expect(page.metadata.anchor).toBe('start');
    for (let i = 0; i < 500; i++) {
      parts.push(page.text);
      if (!page.metadata.next_id) break;
      page = await fetch(page.metadata.next_id);
      expect(page.metadata.anchor).toBe('cursor');
    }
    expect(Buffer.from(parts.join(''), 'utf8').equals(doc)).toBe(true);
  }, 120_000);

  test('a chunk anchor from before a re-chunk falls back to the first window; an old continuation reads on from its offset', async () => {
    await put('notes/moving-example', log(6000));
    const first = await fetch(encodeDeepResearchId('default', 'notes/moving-example'));
    const next = first.metadata.next_id as string;
    const staleChunk = encodeDeepResearchId('default', 'notes/moving-example', { chunkId: 987654321 });
    await put('notes/moving-example', log(6001));
    const fromChunk = await fetch(staleChunk);
    expect(fromChunk.metadata.anchor).toBe('chunk_not_current');
    expect(fromChunk.metadata.window.byte_start).toBe(0);
    const rebased = await fetch(next);
    expect(rebased.metadata.anchor).toBe('cursor_rebased');
    expect(rebased.metadata.window.byte_start).toBeLessThanOrEqual(first.metadata.window.byte_end);
    expect(rebased.metadata.window.byte_start).toBeGreaterThan(0);
  }, 120_000);

  test('a small page still fetches whole, whatever the id carries', async () => {
    const hits = await searchOp.handler(ctx(), { query: 'quasarneedle short' }) as any[];
    const hit = hits.find(h => h.slug === 'notes/short-example');
    const page = await fetch(hit.id);
    expect(page.text).toContain('A short page about quasarneedle short.');
    expect(page.text.startsWith('---\n')).toBe(true);
    expect(page.metadata.truncated).toBeUndefined();
  }, 60_000);

  test('ids reject malformed anchors', () => {
    const wrap = (v: unknown) => 'gbrain-page:v1:' + Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const bad of [['default', 'notes/x', { c: 0 }], ['default', 'notes/x', { c: 'x' }], ['default', 'notes/x', { w: '' }], ['default', 'notes/x', { c: 1, w: 'a' }], ['default', 'notes/x', 5]]) {
      expect(() => decodeDeepResearchId(wrap(bad))).toThrow();
    }
  });
});
