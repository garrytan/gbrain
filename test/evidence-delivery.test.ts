/**
 * Evidence delivery (`return_unit`) — page text, chunk location, units, allocation, spans,
 * errors, snippet precedence and final-consumer wiring.
 *
 * Authoring gate: protects the delivered-evidence contract in
 * docs/evidence-delivery.md (the bytes gbrain-evals measures). Regressions it
 * catches: page text that differs from the body (lost paragraph breaks, duplicated overlap), budget overrun, spans that
 * point at the wrong text, a config flip overriding the subagent snippet cap,
 * mutated shared hit rows, recall/think consumers dropping the evidence.
 * Existing search tests never exercise the stage (it is opt-in). No seams:
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
import { formatDeliverySummary } from '../src/core/search/explain-formatter.ts';
import {
  countEvidenceTokens,
  deliverEvidence,
  deliveryVersionSkewWarning,
  EVIDENCE_BLOCK_CHAR_CAP,
  EVIDENCE_OMISSION,
  evidenceFingerprint,
  isConversationLabels,
  locateChunks,
  pageEvidenceText,
  splitPieces,
  TIMELINE_SEPARATOR,
  type EvidencePlan,
} from '../src/core/search/evidence-delivery.ts';

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

function planOf(unit: EvidencePlan['unit'], budget: number, window = 1): EvidencePlan {
  return { requestedUnit: unit, unit, window, budgetTokens: budget, explicitUnit: true };
}

function randomCorpus(r: () => number, pageCount: number): FakePage[] {
  return Array.from({ length: pageCount }, (_, i) => {
    const conversational = r() < 0.4;
    const body = conversational
      ? Array.from({ length: 6 + Math.floor(r() * 30) }, (_, t) => `**${t % 2 ? 'assistant' : 'user'}:** ${prose(r, 1)}`).join('\n\n')
      : Array.from({ length: 1 + Math.floor(r() * 4) }, (_, s) => `## Section ${s}\n\n${prose(r, 2 + Math.floor(r() * 8))}`).join('\n\n');
    return { page_id: i + 1, slug: `pages/p${i + 1}`, title: `Page ${i + 1}`, body, chunks: chunkText(body).map(c => c.text) };
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
      const unit = (['window', 'section', 'page', 'auto'] as const)[Math.floor(r() * 4)];
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

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [slug, body] of [['chat/session-1', SESSION], ['notes/handbook', HANDBOOK]] as const) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: slug === 'notes/handbook' ? '- 2026-01-02 narwhal timeline entry' : '', frontmatter: {} });
    await installFixtureChunks(engine, slug, await prepareMarkdownChunks({ compiled_truth: body, timeline: slug === 'notes/handbook' ? '- 2026-01-02 narwhal timeline entry' : '' }));
  }
  await engine.setConfig('search.mcp_keyword_only', 'true');
}, 240_000);

afterAll(async () => {
  await engine.disconnect();
}, 240_000);

describe('ops', () => {
  test('omitted return_unit leaves search output without delivery fields', async () => {
    lastMeta = null;
    const rows = await op('search').handler(ctxOf(), { query: 'narwhal' }) as SearchResult[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.delivered === undefined)).toBe(true);
    expect((lastMeta as Record<string, unknown> | null)?.delivery).toBeUndefined();
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
      await engine.setConfig('search.return_unit', 'chunk');
    }
  });

  test('remote budgets clamp to search.return_budget_max_remote and say so', async () => {
    await op('search').handler(ctxOf({ remote: true }), { query: 'narwhal', return_unit: 'window', token_budget: 90000 });
    expect(lastMeta!.delivery.budget_tokens).toBe(32000);
    expect(lastMeta!.delivery.budget_clamped).toEqual({ requested: 90000, max: 32000 });
    expect(lastMeta!.delivery.fallbacks).toContain('budget_clamped');
  });

  test('recall keeps legacy fields and packing, adding delivered/delivery only when on', async () => {
    const off = await op('recall').handler(ctxOf(), { query: 'narwhal', budget_tokens: 5000 }) as Record<string, any>;
    expect(off.delivery).toBeUndefined();
    expect(off.results.every((r: Record<string, unknown>) => Object.keys(r).join(',') === 'slug,title,chunk,evidence,create_safety,provenance')).toBe(true);
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

  test('think renders delivered blocks whole under think.return_unit, and only then', async () => {
    const prompts: string[] = [];
    const client = { create: async (params: { messages: Array<{ content: unknown }> }) => {
      prompts.push(JSON.stringify(params.messages));
      return { content: [{ type: 'text', text: '{"answer":"ok","citations":[],"gaps":[]}' }], usage: { input_tokens: 1, output_tokens: 1 } };
    } };
    await runThink(engine, { question: 'narwhal launch march', client: client as never, remote: false });
    expect(prompts[0]).not.toContain('reply 23 ');
    await engine.setConfig('search.return_unit', 'page');
    try {
      await runThink(engine, { question: 'narwhal launch march', client: client as never, remote: false });
      expect(prompts[1]).not.toContain('reply 23 ');
      await engine.setConfig('think.return_unit', 'page');
      const r = await runThink(engine, { question: 'narwhal launch march', client: client as never, remote: false });
      expect(prompts[2]).toContain('reply 23 ');
      expect(r.evidence_delivery?.requested_unit).toBe('page');
    } finally {
      await engine.setConfig('search.return_unit', 'chunk');
      await engine.setConfig('think.return_unit', 'chunk');
    }
  });

  test('renderPagesBlock verbatim mode passes delivered text through', () => {
    const text = 'x'.repeat(5000);
    const block = renderPagesBlock([{ slug: 'a/b', chunk_text: text } as SearchResult], 60000, 'q', { verbatim: true });
    expect(block).toContain(text);
  });

  test('thin-client skew warning fires only when the server dropped delivery', () => {
    expect(deliveryVersionSkewWarning('query', { return_unit: 'page' }, { returned_count: 1 }, [])).toContain('v0.60.13.0');
    expect(deliveryVersionSkewWarning('query', { return_unit: 'page' }, { delivery: {} }, [])).toBeNull();
    expect(deliveryVersionSkewWarning('query', { return_unit: 'chunk' }, {}, [])).toBeNull();
    expect(deliveryVersionSkewWarning('recall', { return_unit: 'page' }, null, { facts: [] })).toContain('ignored return_unit');
  });
});
