/**
 * GST-4040: long-page evidence-delivery edge cases left after the section default (#10505).
 * The ranked chunk is anchored by its stored span before any text search, a second ranked
 * passage that no longer fits the budget comes back as its own row, and the fence-overlay
 * reads sit inside the long-page deadline. Stub engines answer only what delivery reads.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';
import type { ChunkWindowPage } from '../src/core/search/chunk-windows.ts';
import { deliverEvidence, type EvidencePlan, type LongPageSelection } from '../src/core/search/evidence-delivery.ts';

const PAGE_ID = 7;
const SLUG = 'contracts/terms-example';

function spanned(body: string, pieces: Array<{ text: string; at?: number; stale?: boolean; missing?: boolean }>) {
  return pieces.map((p, i) => {
    const at = p.at ?? body.indexOf(p.text);
    const start = Buffer.byteLength(body.slice(0, at), 'utf8');
    const shift = p.stale ? 3 : 0;
    return {
      id: PAGE_ID * 1000 + i, chunk_index: i, chunk_text: p.text, chunk_source: 'compiled_truth',
      ...(p.missing ? {} : { projected_byte_start: start + shift, projected_byte_end: start + shift + Buffer.byteLength(p.text, 'utf8') }),
    };
  });
}

function stubEngine(body: string, chunks: ChunkWindowPage['chunks'], extra: Record<string, unknown> = {}): BrainEngine {
  return {
    async getChunkWindows(): Promise<ChunkWindowPage[]> {
      return [{ page_id: PAGE_ID, slug: SLUG, source_id: 'default', type: 'note', revision: 'rev-1', sealed: true, max_chunk_index: chunks.length - 1,
        row_limited: false, compiled_truth: body, timeline: '', chunks }];
    },
    ...extra,
  } as unknown as BrainEngine;
}

const hitOn = (chunks: ChunkWindowPage['chunks'], index: number, title = SLUG): SearchResult => ({
  slug: SLUG, page_id: PAGE_ID, title, type: 'note', chunk_text: chunks[index].chunk_text, chunk_source: 'compiled_truth',
  chunk_id: chunks[index].id, chunk_index: index, score: 1, stale: false, source_id: 'default',
});

const sectionPlan = { requestedUnit: 'section', unit: 'section', window: 1, budgetTokens: 20000, explicitUnit: true, budgetExplicit: false, packing: 'cap_only' } as EvidencePlan;
const autoPlan = (budget: number) => ({ requestedUnit: 'auto', unit: 'auto', window: 1, budgetTokens: budget, explicitUnit: false, budgetExplicit: false, packing: 'cap_only' }) as EvidencePlan;
const longPages = (deadlineMs = 2000): LongPageSelection => ({ unit: 'section', minChars: 10, pages: new Set([PAGE_ID]), kept: new Map(), deadlineAt: Date.now() + deadlineMs, fallbacks: [] });

describe('the ranked chunk is anchored by its stored span', () => {
  const PAYMENT = 'Payment is due within thirty days of the invoice date.';
  const body = `# Terms\n\n## Original\n\n${PAYMENT}\n\n## Amendment\n\n${PAYMENT}\n\nThe amendment adds a late fee of two percent per month.\n`;
  const amendmentAt = body.lastIndexOf(PAYMENT);
  const lead = body.slice(0, body.indexOf('## Amendment') + '## Amendment'.length);

  test('identical text under two headings: the section delivered is the ranked hit\'s (Amendment), not the first match (Original)', async () => {
    const chunks = spanned(body, [{ text: lead, at: 0 }, { text: PAYMENT, at: amendmentAt }, { text: 'The amendment adds a late fee of two percent per month.' }]);
    const { results } = await deliverEvidence(stubEngine(body, chunks), [hitOn(chunks, 1)], sectionPlan, {});
    expect(results[0].delivered.unit).toBe('section');
    expect(results[0].chunk_text.startsWith('## Amendment')).toBe(true);
    expect(results[0].chunk_text).not.toContain('## Original');
    const span = results[0].delivered.match_spans.find(s => s.chunk_id === chunks[1].id)!;
    expect(results[0].chunk_text.slice(span.start, span.end)).toBe(PAYMENT);
  });

  test('the same page under auto with the long-page policy delivers the Amendment section too', async () => {
    const chunks = spanned(body, [{ text: lead, at: 0 }, { text: PAYMENT, at: amendmentAt }, { text: 'The amendment adds a late fee of two percent per month.' }]);
    const { results } = await deliverEvidence(stubEngine(body, chunks), [hitOn(chunks, 1)], autoPlan(20000), {}, { longPages: longPages() });
    expect(results[0].delivered).toMatchObject({ unit: 'section', reason: 'long_page' });
    expect(results[0].chunk_text.startsWith('## Amendment')).toBe(true);
  });

  for (const kind of ['missing', 'stale'] as const) {
    test(`a ${kind} stored span falls back to text search and still delivers a section holding the chunk`, async () => {
      const chunks = spanned(body, [{ text: '# Terms' }, { text: '## Amendment' }, { text: 'The amendment adds a late fee of two percent per month.', [kind]: true }]);
      const { results } = await deliverEvidence(stubEngine(body, chunks), [hitOn(chunks, 2)], sectionPlan, {});
      expect(results[0].delivered.unit).toBe('section');
      expect(results[0].chunk_text).toContain('The amendment adds a late fee of two percent per month.');
      expect(results[0].delivered.unmapped_chunk_ids).toBeUndefined();
    });
  }
});

describe('a second ranked passage on the same long page under a tight budget', () => {
  const FIRST = 'Fee is ten.';
  const SECOND = 'The notice period for termination is ninety calendar days after written notice reaches the other party.';
  const body = `## Fees\n\n${FIRST}\n\n## Termination\n\n${SECOND}\n`;
  const chunks = spanned(body, [{ text: `## Fees\n\n${FIRST}` }, { text: `## Termination\n\n${SECOND}` }]);
  const hits = [hitOn(chunks, 0, 'T'), hitOn(chunks, 1, 'T')];

  test('budget 13: the second passage that no longer fits comes back as its ranked chunk, never silently dropped', async () => {
    const { results, delivery } = await deliverEvidence(stubEngine(body, chunks), hits, autoPlan(13), {}, { longPages: longPages() });
    const block = results.find(r => r.delivered.unit === 'section')!;
    expect(block.delivered.chunk_ids).toEqual([chunks[0].id]);
    expect(block.delivered.unmapped_chunk_ids).toBeUndefined();
    expect(block.chunk_text).not.toContain(SECOND);
    const row = results.find(r => r.chunk_id === chunks[1].id && r.delivered.unit === 'chunk')!;
    expect(row.chunk_text).toBe(chunks[1].chunk_text);
    expect(row.delivered.reason).toBe('long_page_chunk');
    expect(results.map(r => r.chunk_id)).toEqual([chunks[0].id, chunks[1].id]);
    expect(delivery.fallbacks).toContain('long_page_over_budget');
  });

  test('with room for both, one section-unit block carries both passages and no fallback row', async () => {
    const { results, delivery } = await deliverEvidence(stubEngine(body, chunks), hits, autoPlan(2000), {}, { longPages: longPages() });
    expect(results).toHaveLength(1);
    expect(results[0].chunk_text).toContain(FIRST);
    expect(results[0].chunk_text).toContain(SECOND);
    expect(results[0].delivered.chunk_ids).toEqual([chunks[0].id, chunks[1].id]);
    expect(delivery.fallbacks).not.toContain('long_page_over_budget');
  });
});

describe('the long-page deadline covers the fence-overlay reads', () => {
  const facts = '<!--- gbrain:facts:begin -->\n\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | The renewal fee is fixed. | fact | 1.0 | world | high | | | | |\n<!--- gbrain:facts:end -->';
  const body = `## Fees\n\nThe renewal fee is listed below.\n\n${facts}\n`;

  test('an overlay read that never answers ends at the deadline: the hit keeps its ranked chunk (long_page_deadline)', async () => {
    const chunks = spanned(body, [{ text: 'The renewal fee is listed below.' }]);
    let overlayReads = 0;
    const engine = stubEngine(body, chunks, { readFenceOverlayRows: () => { overlayReads++; return new Promise(() => {}); } });
    const started = Date.now();
    const { results, delivery } = await deliverEvidence(engine, [hitOn(chunks, 0)], autoPlan(20000), {}, { longPages: longPages(150) });
    expect(overlayReads).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(results[0].chunk_text).toBe(chunks[0].chunk_text);
    expect(results[0].delivered).toMatchObject({ unit: 'chunk', reason: 'long_page_chunk' });
    expect(delivery.fallbacks).toContain('long_page_deadline');
  }, 10_000);
});
