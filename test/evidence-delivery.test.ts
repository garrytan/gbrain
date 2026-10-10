/**
 * Evidence delivery (`return_unit`) — page text, chunk location, units, allocation, spans,
 * errors, snippet precedence and final-consumer wiring.
 *
 * Authoring gate: protects the delivered-evidence contract in
 * docs/evidence-delivery.md (the bytes gbrain-evals measures). Regressions it
 * catches: page text that differs from the body (lost paragraph breaks, duplicated overlap), budget overrun, spans that
 * point at the wrong text, a config flip overriding the subagent snippet cap,
 * mutated shared hit rows, recall/think consumers dropping the evidence, and
 * the auto default touching anything but conversation pages. No seams:
 * the property half drives `deliverEvidence` through a stub engine that only
 * answers `getChunkWindows`; the op half runs the real ops on PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';
import type { ChunkWindowOpts, ChunkWindowPage, ChunkWindowRequest } from '../src/core/search/chunk-windows.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { chunkText } from '../src/core/chunkers/recursive.ts';
import { prepareMarkdownChunks } from '../src/core/markdown-chunks.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { renderPagesBlock } from '../src/core/think/gather.ts';
import { runThink } from '../src/core/think/index.ts';
import { formatDeliverySummary, formatResultsExplain } from '../src/core/search/explain-formatter.ts';
import {
  AUTO_PACKINGS,
  conversationSignal,
  assembleEvidenceForHits,
  capDeliveredSnippets,
  capEngaged,
  countEvidenceTokens,
  deliverEvidence,
  deliveryVersionSkewWarning,
  EVIDENCE_BLOCK_CHAR_CAP,
  EVIDENCE_CUT_MARKER,
  EVIDENCE_OMISSION,
  evidenceFingerprint,
  isConversationLabels,
  locateChunks,
  MIN_EXPLICIT_AUTO_BUDGET,
  pageEvidenceText,
  resolveEvidencePlan,
  splitPieces,
  TIMELINE_SEPARATOR,
  type AutoPacking,
  type EvidencePlan,
} from '../src/core/search/evidence-delivery.ts';
import { searchConfigValueRefusal } from '../src/core/search/config-values.ts';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['alpha', 'river', 'launch', 'march', 'budget', 'widget', 'acme', 'notes', 'said', 'the', 'moved', 'plan', 'review', 'quarter', 'team', 'draft'];

function prose(r: () => number, paragraphs: number): string {
  const out: string[] = [];
  for (let p = 0; p < paragraphs; p++) {
    const sentences: string[] = [];
    const n = 2 + Math.floor(r() * 8);
    for (let s = 0; s < n; s++) {
      const len = 4 + Math.floor(r() * 16);
      const words = Array.from({ length: len }, () => WORDS[Math.floor(r() * WORDS.length)]);
      words[0] = words[0][0].toUpperCase() + words[0].slice(1);
      sentences.push(words.join(' ') + '.');
    }
    out.push(sentences.join(' '));
  }
  return out.join('\n\n');
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('page text and chunk location', () => {
  test('every chunk the chunker cut is located in the body, even where it folded whitespace', () => {
    const r = rng(7);
    for (let doc = 0; doc < 25; doc++) {
      const body = prose(r, 10 + Math.floor(r() * 40));
      const chunks = chunkText(body).map((c, i) => ({ id: i + 1, chunk_index: i, chunk_text: c.text }));
      const spans = locateChunks(body, chunks);
      expect(spans.map(x => x.id)).toEqual(chunks.map(c => c.id));
      for (const sp of spans) expect(norm(body.slice(sp.start, sp.end))).toBe(norm(chunks[sp.id - 1].chunk_text));
      for (let i = 1; i < spans.length; i++) expect(spans[i].start).toBeGreaterThan(spans[i - 1].start);
    }
  });

  test('long turns whose paragraph breaks the chunker folds are delivered byte-identical to the body', async () => {
    const turn = (i: number) => `**${i % 2 ? 'assistant' : 'user'}:** ${Array.from({ length: 40 }, (_, k) => `Sentence ${i}-${k} has several plain words in it.`).join(' ')}`;
    const body = Array.from({ length: 8 }, (_, i) => turn(i)).join('\n\n') + '\n';
    const chunks = chunkText(body).map(c => c.text);
    expect(chunks.some(c => !body.includes(c))).toBe(true);
    const page: FakePage = { page_id: 1, slug: 'chat/long', title: 'Long', body, chunks };
    const { results } = await deliverEvidence(fakeEngine([page]), [hitFor(page, 2)], planOf('page', 32000), {});
    expect(results[0].chunk_text).toBe(body.trimEnd());
    expect(results[0].delivered.truncated).toBe(false);
  });

  test('page text is the whole body sanitized before slicing, timeline joined like the serializer', () => {
    const facts = `<!--- gbrain:facts:begin -->\n\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | PUBLICROW | fact | 1.0 | world | high | | | | |\n| 2 | PRIVATEROW | fact | 1.0 | private | high | | | | |\n<!--- gbrain:facts:end -->`;
    const out = pageEvidenceText({ compiled_truth: `intro\n\n${facts}\n\n<!--- gbrain:takes:begin -->\nTAKEROW\n<!--- gbrain:takes:end -->\nend`, timeline: '- 2026 TIMELINEROW' }, true);
    expect(out.text).toContain('PUBLICROW');
    expect(out.text).not.toContain('PRIVATEROW');
    expect(out.text).not.toContain('TAKEROW');
    expect(out.text).toContain(`end${TIMELINE_SEPARATOR}- 2026 TIMELINEROW`);
    expect(pageEvidenceText({ compiled_truth: 'x', timeline: 'TL' }, false).text).toBe('x');
  });

  test('CJK chunks (char-cut overlap) are located', () => {
    const r = rng(11);
    const cjk = Array.from({ length: 1500 }, () => '天地玄黄宇宙洪荒日月盈昃辰宿列张'[Math.floor(r() * 16)]).join('')
      .replace(/(.{40})/g, '$1。');
    const chunks = chunkText(cjk).map((c, i) => ({ id: i + 1, chunk_index: i, chunk_text: c.text }));
    expect(chunks.length).toBeGreaterThan(2);
    expect(locateChunks(cjk, chunks)).toHaveLength(chunks.length);
  });

  test('splitPieces is lossless and bounded', () => {
    const text = `short line\n${'long '.repeat(300)}\n\nlast`;
    const pieces = splitPieces(text);
    expect(pieces.map(p => text.slice(p.start, p.end)).join('')).toBe(text);
    for (const p of pieces) expect(p.end - p.start).toBeLessThanOrEqual(400);
  });

  test('token counts are CJK-aware (cl100k, not char/4)', () => {
    const cjk = '天地玄黄宇宙洪荒'.repeat(40);
    expect(countEvidenceTokens(cjk)).toBeGreaterThan(cjk.length / 4 * 2);
  });

  test('conversation detection is structural', () => {
    expect(isConversationLabels(['user', 'assistant', 'user', 'assistant'])).toBe(true);
    expect(isConversationLabels(['note', 'note', 'note', 'summary'])).toBe(false);
    expect(isConversationLabels(['user', 'assistant'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property tests over the assembler (stub engine answering getChunkWindows)
// ---------------------------------------------------------------------------

interface FakePage { page_id: number; slug: string; title: string; chunks: string[]; body?: string; sealed?: boolean }

function fakeEngine(pages: FakePage[], opts: { fail?: boolean } = {}): BrainEngine & { calls: number } {
  const engine = {
    calls: 0,
    async getChunkWindows(requests: ChunkWindowRequest[], o: ChunkWindowOpts): Promise<ChunkWindowPage[]> {
      engine.calls++;
      if (opts.fail) throw new Error('synthetic fetch failure');
      const out: ChunkWindowPage[] = [];
      for (const p of pages) {
        const mine = requests.filter(r => r.page_id === p.page_id);
        if (mine.length === 0) continue;
        out.push({
          page_id: p.page_id, slug: p.slug, source_id: 'default', type: 'note', revision: `rev-${p.page_id}`,
          sealed: p.sealed !== false, max_chunk_index: p.chunks.length - 1, row_limited: false,
          compiled_truth: p.body ?? p.chunks.join('\n\n'), timeline: '',
          chunks: p.sealed === false ? [] : p.chunks.map((t, i) => ({ id: p.page_id * 1000 + i, chunk_index: i, chunk_text: t, chunk_source: 'compiled_truth' }))
            .filter(c => mine.some(r => c.chunk_index >= r.from_index && c.chunk_index <= r.to_index))
            .filter(() => o.chunkSources.includes('compiled_truth')),
        });
      }
      return out;
    },
  };
  return engine as unknown as BrainEngine & { calls: number };
}

function hitFor(p: FakePage, index: number): SearchResult {
  return {
    slug: p.slug, page_id: p.page_id, title: p.title, type: 'note', chunk_text: p.chunks[index], chunk_source: 'compiled_truth',
    chunk_id: p.page_id * 1000 + index, chunk_index: index, score: 1, stale: false, source_id: 'default',
  };
}

/**
 * A plan as resolveEvidencePlan builds it. `budgetExplicit` defaults to false:
 * the existing property and spill tests pin today's implied-budget path,
 * which every packing must leave byte-identical; the explicit-budget cap has
 * its own tests below (`capPlan`).
 */
function planOf(unit: EvidencePlan['unit'], budget: number, window = 1, extra: Partial<EvidencePlan> = {}): EvidencePlan {
  return { requestedUnit: unit, unit, window, budgetTokens: budget, explicitUnit: true, budgetExplicit: false, packing: 'cap_only', ...extra };
}

function randomCorpus(r: () => number, pageCount: number): FakePage[] {
  return Array.from({ length: pageCount }, (_, i) => {
    const conversational = r() < 0.4;
    const body = conversational
      ? Array.from({ length: 6 + Math.floor(r() * 30) }, (_, t) => `**${t % 2 ? 'assistant' : 'user'}:** ${prose(r, 1)}`).join('\n\n')
      : Array.from({ length: 1 + Math.floor(r() * 4) }, (_, s) => `## Section ${s}\n\n${prose(r, 2 + Math.floor(r() * 8))}`).join('\n\n');
    return { page_id: i + 1, slug: `${conversational ? 'chat' : 'pages'}/p${i + 1}`, title: `Page ${i + 1}`, body, chunks: chunkText(body).map(c => c.text) };
  });
}

describe('allocation and boundary properties', () => {
  test('budget, rank order, span, cap and non-mutation invariants hold across random corpora', async () => {
    const r = rng(20260930);
    for (let trial = 0; trial < 60; trial++) {
      const pages = randomCorpus(r, 1 + Math.floor(r() * 8));
      const hits: SearchResult[] = [];
      for (let k = 0; k < 1 + Math.floor(r() * 10); k++) {
        const p = pages[Math.floor(r() * pages.length)];
        hits.push(hitFor(p, Math.floor(r() * p.chunks.length)));
      }
      const unit = (['window', 'section', 'page'] as const)[Math.floor(r() * 3)];
      const budget = [40, 200, 800, 3000, 12000][Math.floor(r() * 5)];
      const snapshot = JSON.stringify(hits);
      const engine = fakeEngine(pages);
      const { results, delivery } = await deliverEvidence(engine, hits, planOf(unit, budget, 1 + Math.floor(r() * 3)), {});
      expect(JSON.stringify(hits)).toBe(snapshot);
      expect(engine.calls).toBe(1);
      expect(delivery.budget_used).toBeLessThanOrEqual(budget);
      const order = [...new Set(hits.map(h => h.page_id))];
      expect(results.map(x => x.page_id)).toEqual(order.filter(id => results.some(x => x.page_id === id)));
      expect(new Set(results.map(x => x.page_id)).size).toBe(results.length);
      expect(results.length + delivery.dropped).toBe(order.length);
      for (const res of results) {
        expect(res.chunk_text.length).toBeLessThanOrEqual(EVIDENCE_BLOCK_CHAR_CAP);
        expect(res.delivered.tokens).toBeLessThanOrEqual(budget);
        for (const id of res.delivered.chunk_ids) expect(hits.some(h => h.chunk_id === id && h.page_id === res.page_id)).toBe(true);
        for (const s of res.delivered.match_spans) {
          expect(s.start).toBeGreaterThanOrEqual(0);
          expect(s.end).toBeLessThanOrEqual(res.chunk_text.length);
          const anchor = hits.find(h => h.chunk_id === s.chunk_id)!;
          expect(norm(anchor.chunk_text)).toContain(norm(res.chunk_text.slice(s.start, s.end)));
        }
      }
      const again = await deliverEvidence(fakeEngine(pages), hits, planOf(unit, budget, delivery.return_window), {});
      expect(evidenceFingerprint(again.results)).toBe(evidenceFingerprint(results));
    }
  });

  // Pins the implied-budget path (planOf: budgetExplicit false), which the cap
  // never touches: every chunk is kept and a session that cannot fit spills.
  // "Explicit budget: ..." below is its twin under the cap.
  test('auto: conversation pages whole, every other hit its unchanged chunk, nothing lost, expansion within budget', async () => {
    const r = rng(20261001);
    let sawPage = 0;
    let sawChunk = 0;
    for (let trial = 0; trial < 60; trial++) {
      const pages = randomCorpus(r, 1 + Math.floor(r() * 8));
      const hits: SearchResult[] = [];
      for (let k = 0; k < 1 + Math.floor(r() * 10); k++) {
        const p = pages[Math.floor(r() * pages.length)];
        const h = hitFor(p, Math.floor(r() * p.chunks.length));
        if (!hits.some(x => x.chunk_id === h.chunk_id)) hits.push(h);
      }
      const budget = [40, 200, 800, 3000, 24000][Math.floor(r() * 5)];
      const snapshot = JSON.stringify(hits);
      const engine = fakeEngine(pages);
      const { results, delivery } = await deliverEvidence(engine, hits, planOf('auto', budget), {});
      expect(JSON.stringify(hits)).toBe(snapshot);
      expect(engine.calls).toBe(hits.some(h => h.slug.startsWith('chat/')) ? 1 : 0);
      expect(delivery.dropped).toBe(0);
      const cost = (x: SearchResult) => countEvidenceTokens(x.chunk_text) + countEvidenceTokens(x.title);
      for (const h of hits) expect(results.some(x => x.delivered.chunk_ids.includes(h.chunk_id)), `hit ${h.chunk_id} lost`).toBe(true);
      const firstRank = (x: SearchResult) => Math.min(...x.delivered!.chunk_ids.map(id => hits.findIndex(h => h.chunk_id === id)));
      expect(results.map(firstRank)).toEqual(results.map(firstRank).sort((a, b) => a - b));
      for (const res of results) {
        if (res.delivered.reason === 'not_conversation' || res.delivered.reason === 'conversation_over_budget') {
          sawChunk++;
          const { delivered, ...row } = res;
          expect(row).toEqual(hits.find(h => h.chunk_id === delivered.chunk_ids[0])!);
          expect(delivered).toMatchObject({ unit: 'chunk', truncated: false, match_spans: [{ chunk_id: delivered.chunk_ids[0], start: 0, end: row.chunk_text.length }] });
          expect(delivered.reason === 'not_conversation').toBe(!row.slug.startsWith('chat/'));
        } else {
          sawPage++;
          expect(res.slug.startsWith('chat/')).toBe(true);
          expect(res.delivered).toMatchObject({ unit: 'page', reason: 'conversation_slug' });
          expect(res.delivered.match_spans.length).toBeGreaterThan(0);
        }
      }
      const unchanged = results.filter(x => x.delivered.reason === 'not_conversation');
      const expanded = results.filter(x => x.delivered.unit === 'page');
      expect(new Set(expanded.map(x => x.page_id)).size).toBe(expanded.length);
      expect(expanded.reduce((n, x) => n + cost(x), 0)).toBeLessThanOrEqual(Math.max(0, budget - unchanged.reduce((n, x) => n + cost(x), 0)));
    }
    expect(sawPage).toBeGreaterThan(10);
    expect(sawChunk).toBeGreaterThan(10);
  });

  // Implied budget only: under an explicit budget nothing spills (twin below).
  test('auto gives lower-ranked sessions their matching span, and spills a session that cannot fit to its chunks', async () => {
    const pages = randomCorpus(rng(5), 12).filter(p => p.slug.startsWith('chat/')).slice(0, 3);
    expect(pages).toHaveLength(3);
    const hits = pages.map(p => hitFor(p, Math.floor(p.chunks.length / 2)));
    const floors = hits.reduce((n, h) => n + countEvidenceTokens(h.chunk_text) + countEvidenceTokens(h.title), 0);
    const roomy = await deliverEvidence(fakeEngine(pages), hits, planOf('auto', Math.ceil(floors * 1.5)), {});
    expect(roomy.results.map(x => x.delivered.unit)).toEqual(['page', 'page', 'page']);
    for (const res of roomy.results) expect(res.delivered.match_spans.length).toBeGreaterThan(0);
    // The smallest budget that still gives rank one its page leaves no room for the others' spans.
    let budget = countEvidenceTokens(hits[0].chunk_text);
    let tight = await deliverEvidence(fakeEngine(pages), hits, planOf('auto', budget), {});
    while (tight.results[0].delivered.unit !== 'page') tight = await deliverEvidence(fakeEngine(pages), hits, planOf('auto', ++budget), {});
    expect(tight.results.map(x => x.delivered.reason)).toEqual(['conversation_slug', 'conversation_over_budget', 'conversation_over_budget']);
    expect(tight.results.slice(1).map(x => x.chunk_text)).toEqual(hits.slice(1).map(h => h.chunk_text));
    expect(tight.delivery.dropped).toBe(0);
  });

  test('a budget below every floor cuts rank one to fit and drops the rest', async () => {
    const [a, b] = randomCorpus(rng(3), 2);
    const { results, delivery } = await deliverEvidence(fakeEngine([a, b]), [hitFor(a, 0), hitFor(b, 0)], planOf('page', 12), {});
    expect(results).toHaveLength(1);
    expect(results[0].delivered.truncated).toBe(true);
    expect(delivery.budget_used).toBeLessThanOrEqual(12);
    expect(delivery.dropped_reasons).toEqual({ budget_floor: 1 });
  });

  test('distinct pages keep their matching span before rank one is enriched', async () => {
    const pages = randomCorpus(rng(5), 5).map(p => ({ ...p, body: undefined, chunks: [...p.chunks, ...p.chunks, ...p.chunks] }));
    const hits = pages.map(p => hitFor(p, Math.floor(p.chunks.length / 2)));
    const floors = hits.reduce((n, h) => n + countEvidenceTokens(h.chunk_text) + countEvidenceTokens(h.title), 0);
    const { results } = await deliverEvidence(fakeEngine(pages), hits, planOf('page', Math.ceil(floors * 1.5)), {});
    expect(results).toHaveLength(5);
    expect(results[0].delivered.truncated).toBe(true);
    for (const res of results) expect(res.delivered.match_spans.length).toBeGreaterThan(0);
  });

  test('many sessions, repeated text and missing anchors stay deterministic and explicit', async () => {
    const repeated = 'the same sentence repeats verbatim across every chunk here.';
    const page: FakePage = { page_id: 9, slug: 'chat/repeat', title: 'Repeat', chunks: Array.from({ length: 6 }, () => repeated) };
    const ghost: SearchResult = { ...hitFor(page, 2), chunk_id: 999_999, chunk_text: 'text that is no longer in the page at all' };
    const { results } = await deliverEvidence(fakeEngine([page]), [hitFor(page, 1), ghost], planOf('window', 5000), {});
    expect(results).toHaveLength(1);
    expect(results[0].delivered.chunk_ids).toEqual([9001, 999_999]);
    expect(results[0].delivered.unmapped_chunk_ids).toEqual([999_999]);
    expect(results[0].delivered.match_spans.every(s => s.chunk_id === 9001)).toBe(true);
  });

  test('redaction runs before accounting and unmaps shifted spans', async () => {
    const secret = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const page: FakePage = { page_id: 4, slug: 'notes/keys', title: 'Keys', chunks: [`The deploy key is ${secret} for staging and nothing else here.`] };
    const { results, delivery } = await deliverEvidence(fakeEngine([page]), [hitFor(page, 0)], planOf('page', 5000), {});
    expect(results[0].chunk_text).not.toContain(secret);
    expect(results[0].chunk_text).toContain('<REDACTED:');
    expect(results[0].delivered.match_spans).toEqual([]);
    expect(results[0].delivered.unmapped_chunk_ids).toEqual([4000]);
    expect(delivery.fallbacks).toContain('redaction_unmapped');
  });

  test('oversized pages are cut at the 60,000-character cap, never redacted wholesale', async () => {
    const big = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${'lorem ipsum dolor sit amet '.repeat(90)}`);
    const page: FakePage = { page_id: 2, slug: 'notes/big', title: 'Big', chunks: big };
    const { results } = await deliverEvidence(fakeEngine([page]), [hitFor(page, 20)], planOf('page', 32000), {});
    expect(results[0].chunk_text.length).toBeLessThanOrEqual(EVIDENCE_BLOCK_CHAR_CAP);
    expect(results[0].chunk_text).not.toContain('<REDACTED:output_limit>');
    expect(results[0].delivered.truncated).toBe(true);
    expect(results[0].chunk_text).toContain('Paragraph 20.');
  });

  test('fetch failure falls back to fresh hit chunks, and never to cached ones', async () => {
    const [a] = randomCorpus(rng(8), 1);
    const live = await deliverEvidence(fakeEngine([a], { fail: true }), [hitFor(a, 0)], planOf('page', 5000), {});
    expect(live.results[0].chunk_text).toBe(a.chunks[0]);
    expect(live.results[0].delivered).toMatchObject({ unit: 'chunk', fallback_reason: 'fetch_failed' });
    expect(live.delivery.applied_unit).toBe('chunk');
    const cached = await deliverEvidence(fakeEngine([a], { fail: true }), [hitFor(a, 0)], planOf('page', 5000), {}, { liveHits: false });
    expect(cached.results).toEqual([]);
    expect(cached.delivery.dropped_reasons).toEqual({ not_readable: 1 });
  });

  test('a fetch that exceeds the timeout degrades to fresh hit chunks with a receipt', async () => {
    const [a] = randomCorpus(rng(14), 1);
    const hanging = { getChunkWindows: () => new Promise<never>(() => {}) } as unknown as BrainEngine;
    const { results, delivery } = await deliverEvidence(hanging, [hitFor(a, 0)], planOf('page', 5000), {}, { timeoutMs: 20 });
    expect(results[0].delivered.fallback_reason).toBe('fetch_timeout');
    expect(delivery.fallbacks).toContain('fetch_timeout');
    expect(formatDeliverySummary(delivery)).toContain('fallbacks: fetch_timeout');
  });

  test('a page absent from the re-authorized fetch is dropped, not served from the hit', async () => {
    const [a, b] = randomCorpus(rng(9), 2);
    const { results, delivery } = await deliverEvidence(fakeEngine([a]), [hitFor(b, 0), hitFor(a, 0)], planOf('window', 5000), {});
    expect(results.map(x => x.slug)).toEqual([a.slug]);
    expect(delivery.dropped_reasons).toEqual({ not_readable: 1 });
    expect(JSON.stringify(results)).not.toContain(b.chunks[0].slice(0, 60));
  });

  test('unsealed pages fall back to the hit chunk with a named reason', async () => {
    const [a] = randomCorpus(rng(10), 1);
    const { results } = await deliverEvidence(fakeEngine([{ ...a, sealed: false }]), [hitFor(a, 0)], planOf('page', 5000), {});
    expect(results[0].delivered.fallback_reason).toBe('unsealed_page');
  });

  test('section falls back to window when a page has no structure', async () => {
    const flat = prose(rng(12), 40);
    const page: FakePage = { page_id: 3, slug: 'notes/flat', title: 'Flat', body: flat, chunks: chunkText(flat).map(c => c.text) };
    const { results, delivery } = await deliverEvidence(fakeEngine([page]), [hitFor(page, 2)], planOf('section', 20000), {});
    expect(results[0].delivered.unit).toBe('window');
    expect(delivery.fallbacks).toContain('no_section_structure');
  });

  test('non-contiguous hits on one page join with the fixed omission line', async () => {
    const longBody = prose(rng(13), 80);
    const page: FakePage = { page_id: 5, slug: 'notes/long', title: 'Long', body: longBody, chunks: chunkText(longBody).map(c => c.text) };
    expect(page.chunks.length).toBeGreaterThan(8);
    const { results } = await deliverEvidence(fakeEngine([page]), [hitFor(page, 1), hitFor(page, page.chunks.length - 2)], planOf('window', 20000), {});
    expect(results).toHaveLength(1);
    expect(results[0].chunk_text).toContain(EVIDENCE_OMISSION);
    expect(results[0].delivered.match_spans.map(s => s.chunk_id)).toEqual([5001, 5000 + page.chunks.length - 2]);
  });
});

// ---------------------------------------------------------------------------
// Explicit budgets under auto: the cap (search.auto_packing)
// ---------------------------------------------------------------------------

const CAP_PACKINGS = AUTO_PACKINGS.filter((x): x is Exclude<AutoPacking, 'off'> => x !== 'off');

function capPlan(budget: number, packing: AutoPacking = 'cap_only', window = 1): EvidencePlan {
  return planOf('auto', budget, window, { budgetExplicit: true, packing });
}

const recount = (rows: Array<{ title?: string; chunk_text: string }>) => rows.reduce((n, x) => n + countEvidenceTokens(x.title ?? '') + countEvidenceTokens(x.chunk_text), 0);

/** A chat page of three one-line turns: return_window 1 around turn 1 covers the whole page. */
function chatPage(id: number, words: number, title = `Chat ${id}`): FakePage {
  const r = rng(1000 + id);
  const turn = (who: string, k: number) => `**${who}:** ${Array.from({ length: words }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ')} turn ${id}-${k}.`;
  const chunks = [turn('user', 0), turn('assistant', 1), turn('user', 2)];
  return { page_id: id, slug: `chat/c${id}`, title, chunks };
}

function notePage(id: number, words: number, title = `Note ${id}`): FakePage {
  const r = rng(2000 + id);
  return { page_id: id, slug: `notes/n${id}`, title, chunks: [`${Array.from({ length: words }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ')} note ${id}.`] };
}

const whole = (p: FakePage) => countEvidenceTokens(p.title) + countEvidenceTokens(p.chunks.join('\n\n'));
const floorOf = (p: FakePage, i = 1) => countEvidenceTokens(p.title) + countEvidenceTokens(p.chunks[i] + (i < p.chunks.length - 1 ? '\n' : ''));

describe('explicit budget: the cap', () => {
  test('without an explicit budget every packing is today\'s path, byte for byte (guard 1, structural)', async () => {
    const r = rng(20261009);
    let compared = 0;
    for (let trial = 0; trial < 60; trial++) {
      const pages = randomCorpus(r, 1 + Math.floor(r() * 8));
      const hits: SearchResult[] = [];
      for (let k = 0; k < 1 + Math.floor(r() * 25); k++) {
        const p = pages[Math.floor(r() * pages.length)];
        const h = hitFor(p, Math.floor(r() * p.chunks.length));
        if (!hits.some(x => x.chunk_id === h.chunk_id)) hits.push(h);
      }
      const budget = [40, 200, 800, 3000, 24000][Math.floor(r() * 5)];
      const today = JSON.stringify(await deliverEvidence(fakeEngine(pages), hits, planOf('auto', budget, 1, { packing: 'off' }), {}));
      for (const packing of AUTO_PACKINGS) {
        expect(capEngaged(planOf('auto', budget, 1, { packing }))).toBe(false);
        expect(JSON.stringify(await deliverEvidence(fakeEngine(pages), hits, planOf('auto', budget, 1, { packing }), {}))).toBe(today);
        compared++;
      }
      // An explicit budget with packing off is today's path too.
      expect(JSON.stringify(await deliverEvidence(fakeEngine(pages), hits, capPlan(budget, 'off'), {}))).toBe(today);
    }
    expect(compared).toBe(240);
  });

  // Twin of the implied-budget property above: under the cap the recount of
  // the final evidence fields never exceeds the budget, nothing spills, rank
  // one is always delivered and every hit is delivered or counted as dropped.
  test('explicit budget: the recount never exceeds the budget, nothing spills, rank one survives, every hit is accounted for', async () => {
    const r = rng(20261010);
    let cut = 0;
    let droppedAny = 0;
    for (let trial = 0; trial < 50; trial++) {
      const pages = randomCorpus(r, 1 + Math.floor(r() * 10));
      const hits: SearchResult[] = [];
      for (let k = 0; k < 1 + Math.floor(r() * 25); k++) {
        const p = pages[Math.floor(r() * pages.length)];
        const h = hitFor(p, Math.floor(r() * p.chunks.length));
        if (!hits.some(x => x.chunk_id === h.chunk_id)) hits.push(h);
      }
      const items = new Set(hits.map(h => h.slug.startsWith('chat/') ? `p${h.page_id}` : `c${h.chunk_id}`)).size;
      for (const packing of CAP_PACKINGS) {
        const budget = [MIN_EXPLICIT_AUTO_BUDGET, 40, 200, 800, 3000, 8000, 24000][Math.floor(r() * 7)];
        const snapshot = JSON.stringify(hits);
        const { results, delivery } = await deliverEvidence(fakeEngine(pages), hits, capPlan(budget, packing, 1 + Math.floor(r() * 3)), {});
        const label = `trial ${trial} ${packing} @${budget}`;
        expect(JSON.stringify(hits)).toBe(snapshot);
        expect(recount(results), label).toBeLessThanOrEqual(budget);
        expect(delivery.budget_used, label).toBe(recount(results));
        expect(delivery.auto_packing).toBe(packing);
        expect(results.length, label).toBeGreaterThan(0);
        expect(results[0].delivered.chunk_ids, label).toContain(hits[0].chunk_id);
        expect(results.length + delivery.dropped, label).toBe(items);
        expect(results.some(x => x.delivered.reason === 'conversation_over_budget'), label).toBe(false);
        const firstRank = (x: SearchResult) => Math.min(...x.delivered!.chunk_ids.map(id => hits.findIndex(h => h.chunk_id === id)));
        expect(results.map(firstRank)).toEqual(results.map(firstRank).sort((a, b) => a - b));
        for (const res of results) {
          expect(res.chunk_text.length).toBeLessThanOrEqual(EVIDENCE_BLOCK_CHAR_CAP + EVIDENCE_CUT_MARKER.length);
          for (const sp of res.delivered.match_spans) {
            expect(sp.end).toBeLessThanOrEqual(res.chunk_text.length);
            const anchor = hits.find(h => h.chunk_id === sp.chunk_id)!;
            expect(norm(anchor.chunk_text)).toContain(norm(res.chunk_text.slice(sp.start, sp.end)));
          }
          if (res.chunk_text.endsWith(EVIDENCE_CUT_MARKER)) { cut++; expect(res.delivered.truncated).toBe(true); }
        }
        if (delivery.dropped > 0) droppedAny++;
      }
    }
    expect(cut).toBeGreaterThan(5);
    expect(droppedAny).toBeGreaterThan(20);
  });

  test('explicit budget: a session that cannot fit is dropped, never spilled outside the budget (twin of the spill test)', async () => {
    const pages = randomCorpus(rng(5), 12).filter(p => p.slug.startsWith('chat/')).slice(0, 3);
    const hits = pages.map(p => hitFor(p, Math.floor(p.chunks.length / 2)));
    let budget = countEvidenceTokens(hits[0].chunk_text);
    let tight = await deliverEvidence(fakeEngine(pages), hits, capPlan(budget), {});
    while (tight.results[0].delivered.truncated) tight = await deliverEvidence(fakeEngine(pages), hits, capPlan(++budget), {});
    expect(tight.results.map(x => x.slug)).toEqual([pages[0].slug]);
    expect(tight.delivery.dropped_reasons).toEqual({ budget_floor: 2 });
    expect(tight.delivery.budget_used).toBeLessThanOrEqual(budget);
    const today = await deliverEvidence(fakeEngine(pages), hits, planOf('auto', budget), {});
    expect(today.delivery.budget_used).toBeGreaterThan(budget);
  });

  test('mixed notes and chats: global rank one comes first, note or chat', async () => {
    const [c1, c2] = [chatPage(1, 60), chatPage(2, 60)];
    const n3 = notePage(3, 30);
    const budget = floorOf(c1) + whole(n3) + 4;
    for (const packing of CAP_PACKINGS) {
      const noteFirst = await deliverEvidence(fakeEngine([c1, c2, n3]), [hitFor(n3, 0), hitFor(c1, 1), hitFor(c2, 1)], capPlan(budget, packing), {});
      expect(noteFirst.results.map(x => x.slug), packing).toEqual(packing === 'breadth_capped' ? ['notes/n3'] : ['notes/n3', 'chat/c1']);
      expect(noteFirst.results[0].delivered).toMatchObject({ unit: 'chunk', reason: 'not_conversation', truncated: false });
      const chatFirst = await deliverEvidence(fakeEngine([c1, c2, n3]), [hitFor(c1, 1), hitFor(n3, 0), hitFor(c2, 1)], capPlan(budget, packing), {});
      expect(chatFirst.results.map(x => x.slug), packing).toEqual(['chat/c1', 'notes/n3']);
      expect(recount(chatFirst.results)).toBeLessThanOrEqual(budget);
    }
  });

  test('a leading chat is never crowded out by a lower-ranked note that does not fit', async () => {
    const c1 = chatPage(1, 40);
    const big = notePage(2, 900);
    const budget = whole(c1) + 10;
    for (const packing of CAP_PACKINGS) {
      const { results, delivery } = await deliverEvidence(fakeEngine([c1, big]), [hitFor(c1, 1), hitFor(big, 0)], capPlan(budget, packing), {});
      expect(results.map(x => x.slug), packing).toEqual(['chat/c1']);
      expect(results[0].delivered).toMatchObject({ unit: 'page', truncated: false });
      expect(delivery.dropped_reasons).toEqual({ budget_note: 1 });
    }
    // Today's implied path pays the note first and spills the chat to its chunk.
    const today = await deliverEvidence(fakeEngine([c1, big]), [hitFor(c1, 1), hitFor(big, 0)], planOf('auto', budget), {});
    expect(today.results.map(x => x.delivered.reason)).toEqual(['conversation_over_budget', 'not_conversation']);
  });

  test('notes only, over budget: the rank-order prefix that fits is kept and the rest is listed', async () => {
    const [a, b, c] = [notePage(1, 20), notePage(2, 400), notePage(3, 20)];
    const budget = whole(a) + 40;
    const { results, delivery } = await deliverEvidence(fakeEngine([a, b, c]), [hitFor(a, 0), hitFor(b, 0), hitFor(c, 0)], capPlan(budget), {});
    expect(results.map(x => x.slug)).toEqual(['notes/n1']);
    expect(results[0].chunk_text).toBe(a.chunks[0]);
    expect(delivery.dropped_reasons).toEqual({ budget_note: 2 });
    // Rank one longer than the budget is cut at a piece boundary with the counted marker, never empty.
    const cut = await deliverEvidence(fakeEngine([b, a]), [hitFor(b, 0), hitFor(a, 0)], capPlan(60), {});
    expect(cut.results).toHaveLength(1);
    expect(cut.results[0].chunk_text.endsWith(EVIDENCE_CUT_MARKER)).toBe(true);
    expect(cut.results[0].chunk_text.length).toBeGreaterThan(EVIDENCE_CUT_MARKER.length + 10);
    expect(b.chunks[0].startsWith(cut.results[0].chunk_text.slice(0, -EVIDENCE_CUT_MARKER.length))).toBe(true);
    expect(cut.results[0].delivered).toMatchObject({ truncated: true, match_spans: [{ start: 0, end: cut.results[0].chunk_text.length - EVIDENCE_CUT_MARKER.length }] });
    expect(recount(cut.results)).toBeLessThanOrEqual(60);
    expect(cut.delivery.dropped_reasons).toEqual({ budget_note: 1 });
  });

  test('rank one longer than the budget is cut to fit with a marker, never dropped, in every packing', async () => {
    const big = chatPage(1, 400);
    const other = chatPage(2, 40);
    for (const packing of CAP_PACKINGS) {
      for (const budget of [MIN_EXPLICIT_AUTO_BUDGET, 40, 100]) {
        const { results, delivery } = await deliverEvidence(fakeEngine([big, other]), [hitFor(big, 1), hitFor(other, 1)], capPlan(budget, packing), {});
        expect(results.map(x => x.slug)).toEqual(['chat/c1']);
        expect(results[0].delivered.truncated).toBe(true);
        expect(results[0].chunk_text.endsWith(EVIDENCE_CUT_MARKER)).toBe(true);
        expect(results[0].chunk_text.length - EVIDENCE_CUT_MARKER.length).toBeGreaterThan(0);
        expect(recount(results), `${packing} @${budget}`).toBeLessThanOrEqual(budget);
        expect(delivery.dropped).toBe(1);
      }
    }
  });

  test('breadth_capped keeps the longest rank-order prefix whose title, floor and target window fit, then drops the rest as breadth_cap', async () => {
    const pages = [chatPage(1, 50), chatPage(2, 50), chatPage(3, 50), chatPage(4, 50)];
    const hits = pages.map(p => hitFor(p, 1));
    // return_window 1 around turn 1 is the whole three-turn page, so each group's price is the whole page.
    const budget = whole(pages[0]) + whole(pages[1]) + Math.floor(whole(pages[2]) / 2);
    const { results, delivery } = await deliverEvidence(fakeEngine(pages), hits, capPlan(budget, 'breadth_capped'), {});
    expect(results.map(x => x.slug)).toEqual(['chat/c1', 'chat/c2']);
    for (const res of results) expect(res.delivered).toMatchObject({ unit: 'page', truncated: false });
    expect(delivery.dropped_reasons).toEqual({ breadth_cap: 2 });
    // cap_only on the same budget reserves every floor first, so the third session keeps its span.
    const capOnly = await deliverEvidence(fakeEngine(pages), hits, capPlan(budget, 'cap_only'), {});
    expect(capOnly.results.length).toBeGreaterThan(2);
    // An oversized first group is cut, never skipped.
    const tiny = await deliverEvidence(fakeEngine(pages), hits, capPlan(floorOf(pages[0]) - 5, 'breadth_capped'), {});
    expect(tiny.results.map(x => x.slug)).toEqual(['chat/c1']);
    expect(tiny.results[0].delivered.truncated).toBe(true);
    expect(tiny.delivery.dropped_reasons).toEqual({ breadth_cap: 3 });
    // A first group whose window does not fit keeps its floor (rank one), and the rest are breadth-capped.
    const lead = await deliverEvidence(fakeEngine(pages), hits, capPlan(floorOf(pages[0]) + 6, 'breadth_capped'), {});
    expect(lead.results.map(x => x.slug)).toEqual(['chat/c1']);
    expect(lead.delivery.dropped_reasons).toEqual({ breadth_cap: 3 });
  });

  test('depth_first takes each session whole when it fits, else the largest window, else skips it', async () => {
    const pages = [chatPage(1, 60), chatPage(2, 60), chatPage(3, 60)];
    const hits = pages.map(p => hitFor(p, 1));
    const budget = whole(pages[0]) + floorOf(pages[1]) + 2;
    const depth = await deliverEvidence(fakeEngine(pages), hits, capPlan(budget, 'depth_first'), {});
    expect(depth.results.map(x => x.slug)).toEqual(['chat/c1', 'chat/c2']);
    expect(depth.results[0].delivered).toMatchObject({ unit: 'page', truncated: false });
    expect(depth.results[1].delivered.truncated).toBe(true);
    expect(depth.delivery.dropped_reasons).toEqual({ budget_floor: 1 });
    // cap_only reserves all three floors before growing any session.
    const capOnly = await deliverEvidence(fakeEngine(pages), hits, capPlan(budget, 'cap_only'), {});
    expect(capOnly.results.map(x => x.slug)).toEqual(['chat/c1', 'chat/c2', 'chat/c3']);
    expect(capOnly.results[0].delivered.truncated).toBe(true);
    // Depth first: the leading session grows into what is left before the next one is considered.
    const greedy = await deliverEvidence(fakeEngine([pages[0], pages[1]]), [hitFor(pages[0], 1), hitFor(pages[1], 1)], capPlan(floorOf(pages[0]) + floorOf(pages[1]) + 1, 'depth_first'), {});
    expect(greedy.results.map(x => x.slug)).toEqual(['chat/c1']);
    expect(greedy.delivery.dropped_reasons).toEqual({ budget_floor: 1 });
    // A session whose matching chunk does not fit is skipped; a later one that fits is still taken.
    const [big, small] = [chatPage(5, 400), chatPage(6, 10)];
    const skip = await deliverEvidence(fakeEngine([pages[0], big, small]), [hitFor(pages[0], 1), hitFor(big, 1), hitFor(small, 1)], capPlan(whole(pages[0]) + whole(small) + 2, 'depth_first'), {});
    expect(skip.results.map(x => x.slug)).toEqual(['chat/c1', 'chat/c6']);
    expect(skip.results.map(x => x.delivered.truncated)).toEqual([false, false]);
    expect(skip.delivery.dropped_reasons).toEqual({ budget_floor: 1 });
  });

  test('source swamp: a curated note survives chat dumps that repeat its phrase under a tight budget, in every packing', async () => {
    const phrase = 'renewal window closes friday';
    const dumps = [1, 2, 3, 4].map(id => {
      const p = chatPage(id, 120);
      return { ...p, chunks: p.chunks.map(c => `${c} ${phrase}.`) };
    });
    const note: FakePage = { page_id: 9, slug: 'notes/renewal-policy', title: 'Renewal policy', chunks: [`The ${phrase}; the owner signs it.`] };
    const budget = floorOf(dumps[0]) + whole(note) + 20;
    for (const packing of CAP_PACKINGS) {
      for (let at = 0; at <= 4; at++) {
        const hits = dumps.map(d => hitFor(d, 1));
        hits.splice(at, 0, hitFor(note, 0));
        const { results } = await deliverEvidence(fakeEngine([...dumps, note]), hits, capPlan(budget, packing), {});
        expect(results.some(x => x.slug === 'notes/renewal-policy'), `${packing}, note at rank ${at}`).toBe(true);
        expect(recount(results)).toBeLessThanOrEqual(budget);
      }
    }
  });

  test('zero conversation hits: within the budget the rows are the ranked chunks, unchanged', async () => {
    const notes = [notePage(1, 20), notePage(2, 20)];
    const hits = notes.map(n => hitFor(n, 0));
    const engine = fakeEngine(notes);
    const { results, delivery } = await deliverEvidence(engine, hits, capPlan(4000), {});
    expect(engine.calls).toBe(0);
    expect(results.map(({ delivered, ...row }) => row)).toEqual(hits);
    expect(delivery).toMatchObject({ auto_packing: 'cap_only', dropped: 0, budget_used: recount(results) });
  });

  test('redaction that grows a row is recounted inside the budget', async () => {
    const secret = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const note: FakePage = { page_id: 4, slug: 'notes/keys', title: 'Keys', chunks: [`The deploy key is ${secret} ${secret} ${secret} for staging and nothing else here at all.`] };
    const budget = Math.max(MIN_EXPLICIT_AUTO_BUDGET, whole(note));
    const { results, delivery } = await deliverEvidence(fakeEngine([note]), [hitFor(note, 0)], capPlan(budget), {});
    expect(results[0].chunk_text).not.toContain(secret);
    expect(results[0].chunk_text).toContain('<REDACTED:');
    expect(delivery.fallbacks).toContain('redaction_unmapped');
    expect(recount(results)).toBeLessThanOrEqual(budget);
    expect(delivery.budget_used).toBe(recount(results));
  });

  test('the 60,000-character cap is reached before a large budget, and CJK spans stay UTF-16 exact', async () => {
    const big = Array.from({ length: 40 }, (_, i) => `**${i % 2 ? 'assistant' : 'user'}:** Paragraph ${i}. ${'lorem ipsum dolor sit amet '.repeat(90)}`);
    const page: FakePage = { page_id: 2, slug: 'chat/big', title: 'Big', chunks: big };
    const { results } = await deliverEvidence(fakeEngine([page]), [hitFor(page, 20)], capPlan(32000), {});
    expect(results[0].chunk_text.length).toBeLessThanOrEqual(EVIDENCE_BLOCK_CHAR_CAP);
    expect(results[0].chunk_text).toContain('Paragraph 20.');
    const r = rng(31);
    const cjkTurn = (who: string) => `**${who}:** ${Array.from({ length: 120 }, () => '天地玄黄宇宙洪荒日月盈昃'[Math.floor(r() * 12)]).join('')}`;
    const cjk: FakePage = { page_id: 3, slug: 'chat/cjk', title: '会话', chunks: [cjkTurn('user'), cjkTurn('assistant'), cjkTurn('user'), cjkTurn('assistant')] };
    for (const packing of CAP_PACKINGS) {
      const out = await deliverEvidence(fakeEngine([cjk]), [hitFor(cjk, 2)], capPlan(120, packing), {});
      expect(recount(out.results)).toBeLessThanOrEqual(120);
      for (const sp of out.results[0].delivered.match_spans) expect(cjk.chunks[2]).toContain(out.results[0].chunk_text.slice(sp.start, sp.end));
    }
  });

  test('fetch failure, timeout and cached hits under the cap: fresh chunks within the budget, cached ones dropped', async () => {
    const pages = [chatPage(1, 200), chatPage(2, 200)];
    const hits = pages.map(p => hitFor(p, 1));
    const live = await deliverEvidence(fakeEngine(pages, { fail: true }), hits, capPlan(120), {});
    expect(live.results[0].delivered.fallback_reason).toBe('fetch_failed');
    expect(recount(live.results)).toBeLessThanOrEqual(120);
    const hanging = { getChunkWindows: () => new Promise<never>(() => {}) } as unknown as BrainEngine;
    const slow = await deliverEvidence(hanging, hits, capPlan(120), {}, { timeoutMs: 20 });
    expect(slow.delivery.fallbacks).toContain('fetch_timeout');
    expect(recount(slow.results)).toBeLessThanOrEqual(120);
    const cached = await deliverEvidence(fakeEngine(pages, { fail: true }), hits, capPlan(120), {}, { liveHits: false });
    expect(cached.results).toEqual([]);
    expect(cached.delivery.dropped_reasons).toEqual({ not_readable: 2 });
  });

  test('budgets below the documented minimum, zero, negative and non-finite are refused by name; the minimum is served', async () => {
    const stub = { getConfig: async () => null } as unknown as BrainEngine;
    const plan = (budget: unknown, extra: Record<string, unknown> = {}) => resolveEvidencePlan(stub, {
      remote: false, returnUnit: 'auto', returnWindow: undefined, budget, snippetChars: undefined, snippetCap: 0, op: 'query', ...extra,
    });
    for (const budget of [...Array.from({ length: MIN_EXPLICIT_AUTO_BUDGET - 1 }, (_, i) => i + 1), 0, -5, 31.9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(plan(budget), String(budget)).rejects.toMatchObject({
        code: 'invalid_params', message: expect.stringContaining(`token_budget must be at least ${MIN_EXPLICIT_AUTO_BUDGET} tokens`),
      });
    }
    await expect(plan(3, { op: 'recall' })).rejects.toMatchObject({ message: expect.stringContaining('budget_tokens must be at least') });
    expect(await plan(MIN_EXPLICIT_AUTO_BUDGET)).toMatchObject({ budgetTokens: MIN_EXPLICIT_AUTO_BUDGET, budgetExplicit: true, packing: 'cap_only' });
    // Off the cap the old meanings stand: packing off, another unit, or no budget.
    expect(await plan(5, { autoPacking: 'off' })).toMatchObject({ budgetTokens: 5, budgetExplicit: true, packing: 'off' });
    expect(await plan(5, { returnUnit: 'page' })).toMatchObject({ unit: 'page', budgetTokens: 5 });
    expect(await plan(undefined)).toMatchObject({ budgetTokens: 24000, budgetExplicit: false });
    // With the unit implied, a budget that is not a positive number still means no budget, as before.
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await plan(budget, { returnUnit: undefined, op: 'recall' })).toMatchObject({ unit: 'auto', budgetTokens: 24000, budgetExplicit: false });
    }
    await expect(plan(4000, { autoPacking: 'widest' })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('auto_packing must be one of off, cap_only, breadth_capped, depth_first') });
    // At the minimum a non-empty hit list yields non-empty evidence within it.
    const r = rng(77);
    for (let trial = 0; trial < 20; trial++) {
      const pages = randomCorpus(r, 1 + Math.floor(r() * 5));
      const hits = pages.map(p => hitFor(p, Math.floor(r() * p.chunks.length)));
      for (const packing of CAP_PACKINGS) {
        const { results } = await deliverEvidence(fakeEngine(pages), hits, capPlan(MIN_EXPLICIT_AUTO_BUDGET, packing), {});
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].chunk_text.replace(EVIDENCE_CUT_MARKER, '').trim().length).toBeGreaterThan(0);
        expect(recount(results)).toBeLessThanOrEqual(MIN_EXPLICIT_AUTO_BUDGET);
      }
    }
  });

  test('under the cap a snippet marker is paid from the row\'s own allocation, or left out when it cannot fit', async () => {
    const page = chatPage(1, 30);
    const { results, delivery } = await deliverEvidence(fakeEngine([page]), [hitFor(page, 1)], capPlan(4000), {});
    const before = countEvidenceTokens(results[0].chunk_text);
    const cap = results[0].chunk_text.length - 3;
    const capped = capDeliveredSnippets(results, cap, { ...delivery, fallbacks: [...delivery.fallbacks] });
    expect(capped[0].chunk_text).toContain('[truncated');
    expect(countEvidenceTokens(capped[0].chunk_text)).toBeLessThanOrEqual(before);
    // Without the cap the same snippet cap grows the row (the old behavior, kept for implied budgets).
    const legacy = capDeliveredSnippets(results, cap, { ...delivery, auto_packing: undefined, fallbacks: [...delivery.fallbacks] });
    expect(countEvidenceTokens(legacy[0].chunk_text)).toBeGreaterThan(before);
    // A row too small to hold the marker keeps a shorter body and says so.
    const tiny = [{ ...results[0], chunk_text: 'Short row of ten words that the cap trims here.' }];
    const meta = { ...delivery, fallbacks: [...delivery.fallbacks] };
    const out = capDeliveredSnippets(tiny, 20, meta);
    expect(out[0].chunk_text).not.toContain('[truncated');
    expect(countEvidenceTokens(out[0].chunk_text)).toBeLessThanOrEqual(countEvidenceTokens(tiny[0].chunk_text));
    expect(meta.fallbacks).toEqual(expect.arrayContaining(['snippet_cap', 'snippet_marker_omitted']));
    expect(meta.budget_used).toBe(recount(out));
  });

  test('search.auto_packing refuses unknown values at config set', () => {
    for (const v of AUTO_PACKINGS) expect(searchConfigValueRefusal('search.auto_packing', v)).toBeNull();
    expect(searchConfigValueRefusal('search.auto_packing', 'breadth')).toMatchObject({ message: expect.stringContaining('must be one of off, cap_only, breadth_capped, depth_first'), example: 'cap_only' });
  });
});

// ---------------------------------------------------------------------------
// Real ops on PGLite
// ---------------------------------------------------------------------------

let engine: PGLiteEngine;
const op = (name: string) => operations.find(o => o.name === name)!;
let lastMeta: Record<string, any> | null = null;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as never, config: {} as never, logger: console as never, dryRun: false, remote: false, sourceId: 'default',
    emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval') lastMeta = value as Record<string, any>; },
    ...overrides,
  } as OperationContext;
}

const SESSION = Array.from({ length: 24 }, (_, i) =>
  `**user:** question ${i} ${'about the renewal and the widget roadmap '.repeat(6)}\n\n**assistant:** reply ${i} ${'we discussed timelines and owners '.repeat(6)}${i === 13 ? ' the launch moved to march narwhal' : ''}`,
).join('\n\n');
const HANDBOOK = `## Overview\n\n${prose(rng(21), 6)}\n\n## Pricing\n\n${prose(rng(22), 6)} narwhal pricing note.\n\n## Support\n\n${prose(rng(23), 6)}`;
const codeFn = (name: string) => `export function ${name}(input: number): number {\n${Array.from({ length: 12 }, (_, i) => `  const step${i} = input * ${i + 2} + ${name.length};`).join('\n')}\n  return input;\n}`;
// One prose chunk (index 0) holding the whole fence, then one fenced_code
// chunk per function (indices 1-3): a hit on index 2 or 3 has no prose chunk
// within return_window, and every code chunk carries a synthesized header.
const CODE_PAGE = `## Setup\n\nThe quokka service boots from this module.\n\n\`\`\`ts\n${codeFn('alpha')}\n\n${codeFn('beta')}\n\n${codeFn('gamma')}\n\`\`\`\n\nClosing prose about the quokka service.`;
const CHUNK_HEADER_LINE = /^\[[^\]]+\] fence\.\w+:\d+-\d+ /m;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [slug, body] of [['chat/session-1', SESSION], ['notes/handbook', HANDBOOK], ['notes/quokka-code', CODE_PAGE]] as const) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: slug === 'notes/handbook' ? '- 2026-01-02 narwhal timeline entry' : '', frontmatter: {} });
    await installFixtureChunks(engine, slug, await prepareMarkdownChunks({ compiled_truth: body, timeline: slug === 'notes/handbook' ? '- 2026-01-02 narwhal timeline entry' : '' }));
  }
  await engine.setConfig('search.mcp_keyword_only', 'true');
}, 240_000);

afterAll(async () => {
  await engine.disconnect();
}, 240_000);

describe('ops', () => {
  test('omitted return_unit with no conversation hit is exactly the chunk response', async () => {
    lastMeta = null;
    const rows = await op('search').handler(ctxOf(), { query: 'pricing' }) as SearchResult[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => !r.slug.startsWith('chat/'))).toBe(true);
    expect(rows.every(r => r.delivered === undefined)).toBe(true);
    expect((lastMeta as Record<string, unknown> | null)?.delivery).toBeUndefined();
    const offMeta = lastMeta;
    const chunk = await op('search').handler(ctxOf(), { query: 'pricing', return_unit: 'chunk' }) as SearchResult[];
    expect(JSON.stringify(rows)).toBe(JSON.stringify(chunk));
    expect(JSON.stringify(offMeta)).toBe(JSON.stringify(lastMeta));
  });

  test('omitted return_unit delivers conversation pages whole and keeps other hits as their chunks', async () => {
    lastMeta = null;
    const chunk = await op('search').handler(ctxOf(), { query: 'narwhal', return_unit: 'chunk' }) as SearchResult[];
    const rows = await op('search').handler(ctxOf(), { query: 'narwhal' }) as SearchResult[];
    expect(lastMeta!.delivery).toMatchObject({ requested_unit: 'auto', applied_unit: 'auto', budget_tokens: 24000 });
    const chat = rows.find(r => r.slug === 'chat/session-1')!;
    expect(chat.delivered).toMatchObject({ unit: 'page', reason: 'conversation_slug', truncated: false });
    const [page] = await engine.executeRaw<{ compiled_truth: string; timeline: string }>('SELECT compiled_truth, timeline FROM pages WHERE id = $1', [chat.page_id]);
    expect(chat.chunk_text).toBe(pageEvidenceText(page, true).text.trimEnd());
    expect(rows.filter(r => r.slug === 'chat/session-1')).toHaveLength(1);
    const others = rows.filter(r => r.slug !== 'chat/session-1');
    expect(others.length).toBeGreaterThan(0);
    expect(others.map(({ delivered, ...r }) => { expect(delivered).toMatchObject({ unit: 'chunk', reason: 'not_conversation' }); return r; }))
      .toEqual(chunk.filter(r => r.slug !== 'chat/session-1'));
    const typed = await op('search').handler(ctxOf(), { query: 'quokka' }) as SearchResult[];
    expect(typed.every(r => r.delivered === undefined)).toBe(true);
  });

  test('auto detects conversations by type or slug, deterministically', () => {
    const at = (type: string, slug: string) => conversationSignal({ type, slug });
    for (const t of ['conversation', 'transcript', 'chat', 'meeting', 'slack', 'slack-thread', 'imessage', 'Conversation']) expect(at(t, 'notes/x')).toBe('conversation_type');
    expect(at('note', 'chat/s-1')).toBe('conversation_slug');
    expect(at('note', 'conversations/sessions/2026-01-01-codex-abc')).toBe('conversation_slug');
    for (const [t, slug] of [['note', 'notes/chat'], ['email', 'emails/a'], ['code', 'src/chat.ts'], ['person', 'people/meeting-maker']]) expect(at(t, slug)).toBeNull();
  });

  test('query token_budget, recall budget_tokens/budget_policy and an explicit chunk keep the legacy chunk path under the auto default', async () => {
    lastMeta = null;
    await op('query').handler(ctxOf(), { query: 'narwhal', expand: false, token_budget: 900 });
    expect(lastMeta!.delivery).toBeUndefined();
    await op('search').handler(ctxOf(), { query: 'narwhal', return_unit: 'chunk' });
    expect(lastMeta!.delivery).toBeUndefined();
    const legacy = await op('recall').handler(ctxOf(), { query: 'narwhal', budget_tokens: 5000, budget_policy: 'query_first' }) as Record<string, any>;
    expect(legacy.delivery).toBeUndefined();
    const packed = await op('recall').handler(ctxOf(), { query: 'narwhal', budget_tokens: 5000 }) as Record<string, any>;
    expect(packed.delivery).toBeUndefined();
    const auto = await op('recall').handler(ctxOf(), { query: 'narwhal' }) as Record<string, any>;
    expect(auto.delivery.requested_unit).toBe('auto');
    expect(auto.results.find((r: Record<string, any>) => r.slug === 'chat/session-1').delivered).toMatchObject({ unit: 'page', reason: 'conversation_slug' });
    await engine.setConfig('search.return_unit', 'chunk');
    try {
      await op('search').handler(ctxOf(), { query: 'narwhal' });
      expect(lastMeta!.delivery).toBeUndefined();
    } finally {
      await engine.executeRaw(`DELETE FROM config WHERE key = 'search.return_unit'`);
    }
  });

  test('auto keeps the subagent snippet economy, the remote cap and its own budget key', async () => {
    const sub = await op('search').handler(ctxOf({ viaSubagent: true } as Partial<OperationContext>), { query: 'narwhal' }) as SearchResult[];
    expect(sub.every(r => r.delivered === undefined && r.chunk_text.length <= 300 + 80)).toBe(true);
    await op('search').handler(ctxOf({ remote: true }), { query: 'narwhal', token_budget: 90000 });
    expect(lastMeta!.delivery).toMatchObject({ applied_unit: 'auto', budget_tokens: 32000, budget_clamped: { requested: 90000, max: 32000 } });
    await engine.setConfig('search.return_budget_conversation', '40000');
    try {
      await op('search').handler(ctxOf({ remote: true }), { query: 'narwhal' });
      expect(lastMeta!.delivery.budget_tokens).toBe(32000);
      await op('search').handler(ctxOf(), { query: 'narwhal' });
      expect(lastMeta!.delivery.budget_tokens).toBe(40000);
    } finally {
      await engine.executeRaw(`DELETE FROM config WHERE key = 'search.return_budget_conversation'`);
    }
    const capped = await op('search').handler(ctxOf(), { query: 'narwhal', snippet_chars: 120 }) as SearchResult[];
    expect(capped.every(r => r.chunk_text.length <= 120 + 200)).toBe(true);
  });

  test('explain names each result\'s unit and the auto reason', async () => {
    const rows = await op('search').handler(ctxOf(), { query: 'narwhal' }) as SearchResult[];
    const text = formatResultsExplain(rows, { delivery: lastMeta!.delivery } as never);
    expect(text).toContain('evidence: auto — ');
    expect(text).toContain('evidence: page (conversation_slug)');
    expect(text).toContain('evidence: chunk (not_conversation)');
  });

  test('every unit delivers through search with delivered + delivery meta', async () => {
    for (const unit of ['window', 'section', 'page', 'auto']) {
      lastMeta = null;
      const rows = await op('search').handler(ctxOf(), { query: 'narwhal', return_unit: unit, token_budget: 4000 }) as SearchResult[];
      expect(rows.length).toBeGreaterThan(0);
      expect(lastMeta!.delivery.requested_unit).toBe(unit);
      expect(lastMeta!.delivery.budget_used).toBeLessThanOrEqual(4000);
      for (const r of rows) {
        expect(r.delivered).toBeDefined();
        for (const s of r.delivered!.match_spans) expect(s.end).toBeLessThanOrEqual(r.chunk_text.length);
      }
    }
  });

  test('page evidence is byte-identical to the stored body (sanitized), on the real import path', async () => {
    const rows = await op('search').handler(ctxOf(), { query: 'narwhal', return_unit: 'page', token_budget: 32000 }) as SearchResult[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const [page] = await engine.executeRaw<{ compiled_truth: string; timeline: string }>('SELECT compiled_truth, timeline FROM pages WHERE id = $1', [r.page_id]);
      expect(r.chunk_text).toBe(pageEvidenceText(page, true).text.trimEnd());
    }
  });

  test('auto takes the page branch for a conversation stored as type note', async () => {
    const rows = await op('search').handler(ctxOf(), { query: 'narwhal launch march', return_unit: 'auto', token_budget: 20000 }) as SearchResult[];
    const chat = rows.find(r => r.slug === 'chat/session-1')!;
    expect(chat.delivered!.unit).toBe('page');
    expect(chat.chunk_text).toContain('question 0 ');
    expect(chat.chunk_text).toContain('reply 23 ');
  });

  test('bad return_unit and return_window fail with invalid_params naming the fix', async () => {
    await expect(op('search').handler(ctxOf(), { query: 'x', return_unit: 'paragraph' })).rejects.toMatchObject({
      code: 'invalid_params', message: expect.stringContaining('chunk, window, section, page, auto'), suggestion: expect.stringContaining('"return_unit"'),
    });
    await expect(op('query').handler(ctxOf(), { query: 'x', return_unit: 'window', return_window: 7 })).rejects.toMatchObject({
      code: 'invalid_params', message: 'return_window must be an integer from 1 to 3 (got 7).', suggestion: expect.stringContaining('"return_window": 2'),
    });
  });

  test('detail low never adds timeline text', async () => {
    const low = await op('query').handler(ctxOf(), { query: 'narwhal pricing', return_unit: 'page', detail: 'low', expand: false }) as SearchResult[];
    const book = low.find(r => r.slug === 'notes/handbook')!;
    expect(book.chunk_text).not.toContain('narwhal timeline entry');
    const medium = await op('query').handler(ctxOf(), { query: 'narwhal pricing', return_unit: 'page', expand: false }) as SearchResult[];
    expect(medium.find(r => r.slug === 'notes/handbook')!.chunk_text).toContain('narwhal timeline entry');
  });

  test('snippet precedence: explicit snippet_chars > explicit unit > subagent default > config unit', async () => {
    const sub = ctxOf({ viaSubagent: true } as Partial<OperationContext>);
    const capped = await op('search').handler(sub, { query: 'narwhal', return_unit: 'page', snippet_chars: 120 }) as SearchResult[];
    expect(capped[0].chunk_text).toContain('[truncated');
    expect(capped[0].delivered!.truncated).toBe(true);
    expect(lastMeta!.delivery.fallbacks).toContain('snippet_cap');
    const explicit = await op('search').handler(sub, { query: 'narwhal', return_unit: 'page' }) as SearchResult[];
    expect(explicit[0].chunk_text).not.toContain('[truncated');
    expect(explicit[0].chunk_text.length).toBeGreaterThan(300);
    await engine.setConfig('search.return_unit', 'page');
    try {
      const subDefault = await op('search').handler(sub, { query: 'narwhal' }) as SearchResult[];
      expect(subDefault[0].delivered).toBeUndefined();
      expect(subDefault[0].chunk_text.length).toBeLessThanOrEqual(300 + 80);
      const human = await op('search').handler(ctxOf(), { query: 'narwhal' }) as SearchResult[];
      expect(human[0].delivered).toBeDefined();
    } finally {
      await engine.executeRaw(`DELETE FROM config WHERE key = 'search.return_unit'`);
    }
  });

  test('remote budgets clamp to search.return_budget_max_remote and say so', async () => {
    await op('search').handler(ctxOf({ remote: true }), { query: 'narwhal', return_unit: 'window', token_budget: 90000 });
    expect(lastMeta!.delivery.budget_tokens).toBe(32000);
    expect(lastMeta!.delivery.budget_clamped).toEqual({ requested: 90000, max: 32000 });
    expect(lastMeta!.delivery.fallbacks).toContain('budget_clamped');
  });

  test('recall keeps legacy fields and packing, adding delivered/delivery only when on', async () => {
    const off = await op('recall').handler(ctxOf(), { query: 'narwhal', budget_tokens: 5000, return_unit: 'chunk' }) as Record<string, any>;
    expect(off.delivery).toBeUndefined();
    expect(off.results.every((r: Record<string, unknown>) => Object.keys(r).join(',') === 'slug,title,chunk,evidence,create_safety,provenance,trust_tier,origin')).toBe(true);
    const on = await op('recall').handler(ctxOf(), { query: 'narwhal', budget_tokens: 5000, return_unit: 'page' }) as Record<string, any>;
    expect(on.delivery.requested_unit).toBe('page');
    expect(on.results[0].delivered.unit).toBe('page');
    expect(on.results[0].chunk.length).toBeGreaterThan(off.results[0].chunk.length);
    expect(on.budget_used).toBeLessThanOrEqual(5000);
  });

  test('query token_budget budgets the delivered evidence', async () => {
    const rows = await op('query').handler(ctxOf(), { query: 'narwhal', return_unit: 'page', token_budget: 900, expand: false }) as SearchResult[];
    expect(lastMeta!.delivery.budget_tokens).toBe(900);
    expect(lastMeta!.delivery.budget_used).toBeLessThanOrEqual(900);
    expect(rows.length).toBeGreaterThan(0);
  });

  test('assemble_evidence returns the same evidence as search for the same hits', async () => {
    const hits = await op('search').handler(ctxOf(), { query: 'narwhal' }) as SearchResult[];
    const viaSearch = await op('search').handler(ctxOf(), { query: 'narwhal', return_unit: 'section', token_budget: 3000 }) as SearchResult[];
    const out = await op('assemble_evidence').handler(ctxOf(), {
      hits: hits.map(h => ({ source_id: h.source_id, slug: h.slug, chunk_id: h.chunk_id })), return_unit: 'section', token_budget: 3000,
    }) as { results: SearchResult[]; unresolved: number[] };
    expect(out.unresolved).toEqual([]);
    expect(evidenceFingerprint(out.results)).toBe(evidenceFingerprint(viaSearch));
    const bad = await op('assemble_evidence').handler(ctxOf(), { hits: [{ source_id: 'nope', slug: 'chat/session-1', chunk_id: 1 }], return_unit: 'page' }) as { unresolved: number[] };
    expect(bad.unresolved).toEqual([0]);
  });

  test('malformed assemble_evidence hits name the parameter in the caller\'s own syntax', async () => {
    await expect(op('assemble_evidence').handler(ctxOf(), { hits: 'chat/session-1' })).rejects.toMatchObject({
      code: 'invalid_params', suggestion: expect.stringContaining('Pass --hits as a array'),
    });
    await expect(op('assemble_evidence').handler(ctxOf({ remote: true, transport: 'stdio' }), { hits: [{ slug: 'chat/session-1' }] })).rejects.toMatchObject({
      code: 'invalid_params', suggestion: expect.stringContaining('assemble_evidence {"hits": [{"source_id":"default","slug":"chat/session-0412","chunk_id":8812}]}'),
    });
    await expect(assembleEvidenceForHits(engine, { hits: 'x' as never, return_unit: 'page' })).rejects.toMatchObject({ code: 'invalid_params', suggestion: expect.stringContaining('"chunk_id": 12') });
  });

  test('a fenced-code best hit delivers the page text for return_unit page, not the code chunk', async () => {
    const [page] = await engine.executeRaw<{ compiled_truth: string; timeline: string }>(`SELECT compiled_truth, timeline FROM pages WHERE slug = 'notes/quokka-code'`);
    const code = await engine.executeRaw<{ id: number; chunk_index: number; chunk_text: string }>(
      `SELECT cc.id, cc.chunk_index, cc.chunk_text FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = 'notes/quokka-code' AND cc.chunk_source = 'fenced_code' ORDER BY cc.chunk_index`);
    expect(code.map(c => c.chunk_index)).toEqual([1, 2, 3]);
    const text = pageEvidenceText(page, true).text;
    for (const c of code) {
      const out = await op('assemble_evidence').handler(ctxOf(), {
        hits: [{ source_id: 'default', slug: 'notes/quokka-code', chunk_id: c.id }], return_unit: 'page', token_budget: 32000,
      }) as { results: SearchResult[]; delivery: { fallbacks: string[] } };
      const [r] = out.results;
      expect(r.delivered!.unit, `chunk_index ${c.chunk_index}`).toBe('page');
      expect(r.delivered!.fallback_reason).toBeUndefined();
      expect(r.delivered!.unmapped_chunk_ids).toBeUndefined();
      expect(r.chunk_text).toBe(text.trimEnd());
      const [span] = r.delivered!.match_spans;
      expect(span.chunk_id).toBe(c.id);
      expect(norm(r.chunk_text.slice(span.start, span.end))).toBe(norm(c.chunk_text.replace(/^[^\n]*\n\n/, '')));
    }
  });

  test('fenced-code evidence never carries the chunker header, in any expanding unit or fallback', async () => {
    const [page] = await engine.executeRaw<{ compiled_truth: string; timeline: string }>(`SELECT compiled_truth, timeline FROM pages WHERE slug = 'notes/quokka-code'`);
    const text = pageEvidenceText(page, true).text;
    const code = await engine.executeRaw<{ id: number }>(
      `SELECT cc.id FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = 'notes/quokka-code' AND cc.chunk_source = 'fenced_code'`);
    for (const unit of ['window', 'section', 'page']) {
      for (const budget of [32000, 60]) {
        const out = await op('assemble_evidence').handler(ctxOf(), {
          hits: code.map(c => ({ source_id: 'default', slug: 'notes/quokka-code', chunk_id: c.id })), return_unit: unit, token_budget: budget,
        }) as { results: SearchResult[] };
        for (const r of out.results) {
          expect(r.chunk_text, `${unit}/${budget}`).not.toMatch(CHUNK_HEADER_LINE);
          for (const seg of r.chunk_text.split(EVIDENCE_OMISSION)) expect(text.includes(seg), `${unit}/${budget}: ${seg.slice(0, 60)}`).toBe(true);
        }
      }
    }
    // auto leaves a non-conversation page on the chunk path: the ranked rows, unchanged.
    const auto = await op('assemble_evidence').handler(ctxOf(), {
      hits: code.map(c => ({ source_id: 'default', slug: 'notes/quokka-code', chunk_id: c.id })), return_unit: 'auto',
    }) as { results: SearchResult[] };
    expect(auto.results.map(r => r.delivered!.reason)).toEqual(['not_conversation', 'not_conversation', 'not_conversation']);
    const plain = await op('assemble_evidence').handler(ctxOf(), {
      hits: code.map(c => ({ source_id: 'default', slug: 'notes/quokka-code', chunk_id: c.id })), return_unit: 'chunk',
    }) as { results: SearchResult[] };
    expect(auto.results.map(r => r.chunk_text)).toEqual(plain.results.map(r => r.chunk_text));
    const hits = await op('search').handler(ctxOf(), { query: 'quokka' }) as SearchResult[];
    const codeHit = { ...hits.find(h => h.slug === 'notes/quokka-code')!, chunk_id: code[1].id, chunk_index: 2, chunk_source: 'fenced_code' as const,
      chunk_text: (await engine.executeRaw<{ chunk_text: string }>('SELECT chunk_text FROM content_chunks WHERE id = $1', [code[1].id]))[0].chunk_text };
    expect(codeHit.chunk_text).toMatch(CHUNK_HEADER_LINE);
    const failing = { getChunkWindows: async () => { throw new Error('synthetic fetch failure'); } } as unknown as BrainEngine;
    const fallback = await deliverEvidence(failing, [codeHit], planOf('page', 5000), {});
    expect(fallback.results[0].delivered).toMatchObject({ unit: 'chunk', fallback_reason: 'fetch_failed' });
    expect(fallback.results[0].chunk_text).not.toMatch(CHUNK_HEADER_LINE);
    expect(text.includes(fallback.results[0].chunk_text)).toBe(true);
  });

  test('think renders delivered blocks whole under think.return_unit, and only then', async () => {
    const prompts: string[] = [];
    const client = { create: async (params: { messages: Array<{ content: unknown }> }) => {
      prompts.push(JSON.stringify(params.messages));
      return { content: [{ type: 'text', text: '{"answer":"ok","citations":[],"gaps":[]}' }], usage: { input_tokens: 1, output_tokens: 1 } };
    } };
    const auto = await runThink(engine, { question: 'narwhal launch march', client: client as never, remote: false });
    expect(prompts[0]).toContain('reply 23 ');
    expect(auto.evidence_delivery?.requested_unit).toBe('auto');
    await engine.setConfig('think.return_unit', 'chunk');
    try {
      await runThink(engine, { question: 'narwhal launch march', client: client as never, remote: false });
      expect(prompts[1]).not.toContain('reply 23 ');
      await engine.setConfig('search.return_unit', 'chunk');
      await engine.setConfig('think.return_unit', 'page');
      const r = await runThink(engine, { question: 'narwhal launch march', client: client as never, remote: false });
      expect(prompts[2]).toContain('reply 23 ');
      expect(r.evidence_delivery?.requested_unit).toBe('page');
    } finally {
      await engine.executeRaw(`DELETE FROM config WHERE key IN ('search.return_unit', 'think.return_unit')`);
    }
  });

  test('renderPagesBlock verbatim mode passes delivered text through', () => {
    const text = 'x'.repeat(5000);
    const block = renderPagesBlock([{ slug: 'a/b', chunk_text: text } as SearchResult], 60000, 'q', { verbatim: true });
    expect(block).toContain(text);
  });

  test('explicit budgets below the minimum are refused through query, search, recall and assemble_evidence; a bare query budget stays legacy chunk (G7)', async () => {
    const msg = (name: string) => expect.stringContaining(`${name} must be at least ${MIN_EXPLICIT_AUTO_BUDGET} tokens under return_unit auto`);
    await expect(op('query').handler(ctxOf(), { query: 'narwhal', return_unit: 'auto', token_budget: 10, expand: false })).rejects.toMatchObject({ code: 'invalid_params', message: msg('token_budget') });
    await expect(op('search').handler(ctxOf(), { query: 'narwhal', token_budget: 5 })).rejects.toMatchObject({ code: 'invalid_params', message: msg('token_budget') });
    await expect(op('recall').handler(ctxOf(), { query: 'narwhal', return_unit: 'auto', budget_tokens: 3 })).rejects.toMatchObject({ code: 'invalid_params', message: msg('budget_tokens') });
    await expect(op('assemble_evidence').handler(ctxOf(), { hits: [{ source_id: 'default', slug: 'chat/session-1', chunk_id: 0 }], return_unit: 'auto', token_budget: 0 }))
      .rejects.toMatchObject({ code: 'invalid_params', message: msg('token_budget') });
    lastMeta = null;
    const bare = await op('query').handler(ctxOf(), { query: 'narwhal', token_budget: 10, expand: false }) as SearchResult[];
    expect(lastMeta!.delivery).toBeUndefined();
    expect(bare.every(r => r.delivered === undefined)).toBe(true);
  });

  test('an explicit budget caps query, search, recall and assemble_evidence at the final boundary, snippet markers included', async () => {
    const rowsCost = (rows: Array<{ title?: string; chunk_text: string }>) => recount(rows);
    for (const budget of [MIN_EXPLICIT_AUTO_BUDGET, 60, 400, 3000]) {
      const viaQuery = await op('query').handler(ctxOf(), { query: 'narwhal', return_unit: 'auto', token_budget: budget, expand: false }) as SearchResult[];
      expect(lastMeta!.delivery).toMatchObject({ auto_packing: 'cap_only', budget_tokens: budget });
      expect(rowsCost(viaQuery), `query @${budget}`).toBeLessThanOrEqual(budget);
      expect(lastMeta!.delivery.budget_used).toBe(rowsCost(viaQuery));
      const viaSearch = await op('search').handler(ctxOf(), { query: 'narwhal', token_budget: budget }) as SearchResult[];
      expect(rowsCost(viaSearch), `search @${budget}`).toBeLessThanOrEqual(budget);
      for (const snippet of [10, 40, 120]) {
        const capped = await op('query').handler(ctxOf(), { query: 'narwhal', return_unit: 'auto', token_budget: budget, snippet_chars: snippet, expand: false }) as SearchResult[];
        expect(rowsCost(capped), `query @${budget} snippet ${snippet}`).toBeLessThanOrEqual(budget);
        expect(lastMeta!.delivery.budget_used).toBe(rowsCost(capped));
        expect(lastMeta!.delivery.tokens_delivered).toBe(capped.reduce((n, r) => n + countEvidenceTokens(r.chunk_text), 0));
      }
      const recall = await op('recall').handler(ctxOf(), { query: 'narwhal', return_unit: 'auto', budget_tokens: budget }) as Record<string, any>;
      expect(recall.delivery.auto_packing).toBe('cap_only');
      expect(recall.delivery.budget_used).toBeLessThanOrEqual(budget);
      const hits = await op('query').handler(ctxOf(), { query: 'narwhal', return_unit: 'chunk', expand: false }) as SearchResult[];
      const assembled = await op('assemble_evidence').handler(ctxOf(), {
        hits: hits.map(h => ({ source_id: h.source_id, slug: h.slug, chunk_id: h.chunk_id })), return_unit: 'auto', token_budget: budget,
      }) as { results: SearchResult[]; delivery: { budget_used: number } };
      expect(rowsCost(assembled.results), `assemble @${budget}`).toBeLessThanOrEqual(budget);
      expect(assembled.delivery.budget_used).toBe(rowsCost(assembled.results));
    }
    // The remote clamp: the cap applies to the clamped value.
    const remote = await op('search').handler(ctxOf({ remote: true }), { query: 'narwhal', token_budget: 90000, fields: 'full' }) as SearchResult[];
    expect(lastMeta!.delivery).toMatchObject({ budget_tokens: 32000, budget_clamped: { requested: 90000, max: 32000 }, auto_packing: 'cap_only' });
    expect(rowsCost(remote)).toBeLessThanOrEqual(32000);
  });

  test('search.auto_packing selects the packing; the library override wins per call; neither touches a call without a budget', async () => {
    const baseline = async () => {
      const out: string[] = [];
      out.push(JSON.stringify(await op('search').handler(ctxOf(), { query: 'narwhal' })), JSON.stringify(lastMeta));
      out.push(JSON.stringify(await op('query').handler(ctxOf(), { query: 'narwhal', expand: false })), JSON.stringify(lastMeta));
      out.push(JSON.stringify(await op('query').handler(ctxOf(), { query: 'narwhal', return_unit: 'auto', expand: false })), JSON.stringify(lastMeta));
      out.push(JSON.stringify(await op('recall').handler(ctxOf(), { query: 'narwhal' })));
      const hits = await op('search').handler(ctxOf(), { query: 'narwhal', return_unit: 'chunk' }) as SearchResult[];
      out.push(JSON.stringify(await op('assemble_evidence').handler(ctxOf(), { hits: hits.map(h => ({ source_id: h.source_id, slug: h.slug, chunk_id: h.chunk_id })), return_unit: 'auto' })));
      return out;
    };
    const today = await baseline();
    try {
      for (const packing of AUTO_PACKINGS) {
        await engine.setConfig('search.auto_packing', packing);
        expect(await baseline(), packing).toEqual(today);
        await op('query').handler(ctxOf(), { query: 'narwhal', return_unit: 'auto', token_budget: 3000, expand: false });
        if (packing === 'off') expect(lastMeta!.delivery.auto_packing).toBeUndefined();
        else expect(lastMeta!.delivery.auto_packing).toBe(packing);
      }
      await engine.setConfig('search.auto_packing', 'depth_first');
      const hits = await op('search').handler(ctxOf(), { query: 'narwhal', return_unit: 'chunk' }) as SearchResult[];
      const frozen = hits.map(h => ({ source_id: h.source_id!, slug: h.slug, chunk_id: h.chunk_id }));
      for (const packing of AUTO_PACKINGS) {
        const out = await assembleEvidenceForHits(engine, { hits: frozen, return_unit: 'auto', budget_tokens: 3000, auto_packing: packing });
        expect(out.delivery!.auto_packing).toBe(packing === 'off' ? undefined : packing);
      }
      await expect(assembleEvidenceForHits(engine, { hits: frozen, return_unit: 'auto', budget_tokens: 3000, auto_packing: 'widest' as never }))
        .rejects.toMatchObject({ code: 'invalid_params' });
    } finally {
      await engine.executeRaw(`DELETE FROM config WHERE key = 'search.auto_packing'`);
    }
    // An explicit 24,000 and the implied 24,000 resolve to plans that differ only in the flag.
    const resolve = (budget: unknown) => resolveEvidencePlan(engine, { remote: false, returnUnit: 'auto', returnWindow: undefined, budget, snippetChars: undefined, snippetCap: 0, op: 'search' });
    const [explicit, implied] = [await resolve(24000), await resolve(undefined)];
    expect({ ...explicit!, budgetExplicit: false }).toEqual(implied!);
    expect(explicit!.budgetExplicit).toBe(true);
  });

  test('think passes no budget, so its prompt is the same under every packing', async () => {
    const prompts: string[] = [];
    const client = { create: async (params: { messages: Array<{ content: unknown }> }) => {
      prompts.push(JSON.stringify(params.messages));
      return { content: [{ type: 'text', text: '{"answer":"ok","citations":[],"gaps":[]}' }], usage: { input_tokens: 1, output_tokens: 1 } };
    } };
    try {
      for (const packing of AUTO_PACKINGS) {
        await engine.setConfig('search.auto_packing', packing);
        await runThink(engine, { question: 'narwhal launch march', client: client as never, remote: false, reference_date: '2026-10-09' } as never);
      }
    } finally {
      await engine.executeRaw(`DELETE FROM config WHERE key = 'search.auto_packing'`);
    }
    expect(new Set(prompts).size).toBe(1);
  });

  test('frozen-hit delivery carries effective_date, and every field a reader consumes equals live query (both packings and today\'s auto)', async () => {
    await engine.executeRaw(`UPDATE pages SET effective_date = '2026-03-04', effective_date_source = 'frontmatter' WHERE slug = 'chat/session-1'`);
    try {
      const hits = await op('query').handler(ctxOf(), { query: 'narwhal', return_unit: 'chunk', expand: false }) as SearchResult[];
      expect(lastMeta!.delivery).toBeUndefined();
      const frozen = hits.map(h => ({ source_id: h.source_id!, slug: h.slug, chunk_id: h.chunk_id }));
      const consumed = (rows: SearchResult[]) => rows.map(r => ({
        slug: r.slug, title: r.title, chunk_text: r.chunk_text, effective_date: r.effective_date, effective_date_source: r.effective_date_source,
        unit: r.delivered?.unit, spans: r.delivered?.match_spans, tokens: r.delivered?.tokens, truncated: r.delivered?.truncated, reason: r.delivered?.reason,
        fallback: r.delivered?.fallback_reason, unmapped: r.delivered?.unmapped_chunk_ids,
      }));
      const totals = (d: Record<string, any>) => ({ budget_used: d.budget_used, tokens_delivered: d.tokens_delivered, fallbacks: d.fallbacks, dropped_reasons: d.dropped_reasons, auto_packing: d.auto_packing });
      let dated = 0;
      for (const packing of AUTO_PACKINGS) {
        await engine.setConfig('search.auto_packing', packing);
        for (const budget of [400, 3000, undefined]) {
          const live = await op('query').handler(ctxOf(), { query: 'narwhal', return_unit: 'auto', expand: false, ...(budget ? { token_budget: budget } : {}) }) as SearchResult[];
          const liveDelivery = lastMeta!.delivery;
          const assembled = await assembleEvidenceForHits(engine, { hits: frozen, return_unit: 'auto', ...(budget ? { budget_tokens: budget } : {}) });
          expect(consumed(assembled.results as SearchResult[]), `${packing} @${budget}`).toEqual(consumed(live));
          expect(totals(assembled.delivery!)).toEqual(totals(liveDelivery));
          expect(evidenceFingerprint(assembled.results)).toBe(evidenceFingerprint(live));
          for (const r of assembled.results.filter(x => x.slug === 'chat/session-1')) { expect(r.effective_date).toBe('2026-03-04'); dated++; }
          // A page with no date reads null on both paths, never an invented date.
          for (const r of assembled.results.filter(x => x.slug !== 'chat/session-1')) expect(r.effective_date).toBeNull();
        }
      }
      expect(dated).toBeGreaterThan(0);
    } finally {
      await engine.executeRaw(`UPDATE pages SET effective_date = NULL, effective_date_source = NULL WHERE slug = 'chat/session-1'`);
      await engine.executeRaw(`DELETE FROM config WHERE key = 'search.auto_packing'`);
    }
  });

  test('thin-client skew warning fires only when the server dropped delivery', () => {
    expect(deliveryVersionSkewWarning('query', { return_unit: 'page' }, { returned_count: 1 }, [])).toContain('v0.60.13.0');
    expect(deliveryVersionSkewWarning('query', { return_unit: 'page' }, { delivery: {} }, [])).toBeNull();
    expect(deliveryVersionSkewWarning('query', { return_unit: 'chunk' }, {}, [])).toBeNull();
    expect(deliveryVersionSkewWarning('recall', { return_unit: 'page' }, null, { facts: [] })).toContain('ignored return_unit');
  });
});
