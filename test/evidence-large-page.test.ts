/**
 * Large pages (Wave A, T18): evidence delivery never assembles a page over the
 * inline read size whole. A 'page' unit (assemble_evidence's default, query
 * return_unit: 'page') becomes the window around the hits, and `delivered`
 * names the downgrade. Above 1 MiB hits are anchored by their stored spans,
 * with no whole-text whitespace folding. Hermetic in-memory PGLite.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { pageDocument } from '../src/core/page-window/document.ts';
import { PAGE_OVER_INLINE_BYTES } from '../src/core/search/evidence-delivery.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../src/core/search/safe-chunks.ts';

let engine: PGLiteEngine;
const assemble = operations.find(o => o.name === 'assemble_evidence')!;
const ctx = (): OperationContext => ({ engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default',
  emitResponseMeta: () => {} } as unknown as OperationContext);

function conversation(lines: number): string {
  return ['# Session log', '', ...Array.from({ length: lines }, (_, i) => i % 2 === 0
    ? `**user:** 2026-04-${String(1 + (i % 28)).padStart(2, '0')} question ${i} about the acme-example widget rollout`
    : `**assistant:** answer ${i}: the widget rollout step ${i} is scheduled`)].join('\n');
}

async function put(slug: string, body: string) {
  const r = await importFromContent(engine, slug, serializeMarkdown({}, body, '', { type: 'conversation', title: slug, tags: [] }), { sourceId: 'default', noEmbed: true, forceRechunk: true });
  expect(r.status).toBe('imported');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Wave A inline behaviour: pin segmented storage off (segmented evidence: test/large-pages/segmented-evidence*.test.ts).
  await engine.setConfig('pages.segmented_storage', 'off');
}, 120_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);

describe('assemble_evidence on large pages', () => {
  test("a 'page' unit over the inline size is delivered as a window and says so", async () => {
    await put('chat/mid-example', conversation(5000));
    const chunks = await engine.getChunks('chat/mid-example', { sourceId: 'default' } as any);
    const target = chunks[chunks.length - 3];
    const out = await assemble.handler(ctx(), { hits: [{ source_id: 'default', slug: 'chat/mid-example', chunk_id: target.id }], return_unit: 'page', token_budget: 20_000 }) as { results: any[] };
    const r = out.results[0];
    expect(r.delivered.unit).toBe('window');
    expect(r.delivered.fallback_reason).toBe(PAGE_OVER_INLINE_BYTES);
    expect(r.chunk_text.replace(/\s+/g, ' ')).toContain(target.chunk_text.replace(/\s+/g, ' ').slice(0, 120));
    expect(r.chunk_text.length).toBeLessThan(200_000);
  }, 60_000);

  test('a small page keeps its whole-page unit', async () => {
    await put('chat/small-example', conversation(40));
    const [c] = await engine.getChunks('chat/small-example', { sourceId: 'default' } as any);
    const out = await assemble.handler(ctx(), { hits: [{ source_id: 'default', slug: 'chat/small-example', chunk_id: c.id }], return_unit: 'page' }) as { results: any[] };
    expect(out.results[0].delivered.unit).toBe('page');
    expect(out.results[0].delivered.fallback_reason).toBeUndefined();
  }, 60_000);

  test('above 1 MiB hits are anchored by stored spans only: a duplicate line by its span, a span-less chunk not at all', async () => {
    const repeated = 'the same rollout message, sent again and again in this session. '.repeat(20);
    await put('chat/huge-example', Array.from({ length: 1200 }, (_, i) => `**user:** ${i % 2 ? repeated : `turn ${i}: ${repeated}`}`).join('\n\n'));
    const snap = await engine.readPageSnapshot('chat/huge-example', { sourceId: 'default' });
    const doc = pageDocument({ compiled_truth: snap!.page.compiled_truth, timeline: snap!.page.timeline });
    expect(doc.bytes.length).toBeGreaterThan(1024 * 1024);
    // Ingest leaves an oversized page chunkless in Wave A; write three chunks with spans the way the chunker records them.
    const text = doc.bytes.toString('utf8');
    // Odd turns are byte-identical lines: only the stored span can tell which one a chunk is.
    const identical = [...text.matchAll(/^\*\*user:\*\* the same/gm)].map(m => m.index!);
    const pick = [identical[1], identical[150], identical[295]];
    const rows = pick.map((at, i) => {
      const end = text.indexOf('\n', at);
      const chunk = text.slice(at, end === -1 ? text.length : end);
      const start = Buffer.byteLength(text.slice(0, at));
      return { chunk_index: i, chunk_text: chunk, chunk_source: 'compiled_truth' as const, projected_byte_start: start, projected_byte_end: start + Buffer.byteLength(chunk) };
    });
    // A fourth chunk with no recorded span whose whitespace differs from the page: only whole-text folding could place it.
    const unique = text.slice(text.indexOf('**user:** turn 800:'), text.indexOf('\n', text.indexOf('**user:** turn 800:'))).replace(/\. /g, '.  ');
    await engine.upsertChunks('chat/huge-example', [...rows, { chunk_index: 3, chunk_text: unique, chunk_source: 'compiled_truth' as const }],
      { sourceId: 'default', sealChunkerVersion: SAFE_FENCE_CHUNKER_VERSION });
    const chunks = await engine.getChunks('chat/huge-example', { sourceId: 'default' } as any);
    expect(chunks[0].chunk_text).toBe(chunks[2].chunk_text);
    const located = await assemble.handler(ctx(), { hits: [{ source_id: 'default', slug: 'chat/huge-example', chunk_id: chunks[2].id }], return_unit: 'window', token_budget: 4000 }) as { results: any[] };
    expect(located.results[0].delivered.unit).toBe('window');
    expect(located.results[0].delivered.match_spans.length).toBeGreaterThan(0);
    const unplaced = await assemble.handler(ctx(), { hits: [{ source_id: 'default', slug: 'chat/huge-example', chunk_id: chunks[3].id }], return_unit: 'window', token_budget: 4000 }) as { results: any[] };
    expect(unplaced.results[0].delivered.unmapped_chunk_ids).toContain(chunks[3].id);
    expect(located.results[0].delivered.unmapped_chunk_ids).toBeUndefined();
  }, 120_000);
});
