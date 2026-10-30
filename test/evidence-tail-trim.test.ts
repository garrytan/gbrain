/**
 * GBRA-156: the protected tail trim (`search.evidence_tail_trim`). Under
 * `auto`, whole-conversation blocks past the top 3 scored under half of rank
 * one are dropped, unless they hold the query's terms nearly as fully as rank
 * one. The regression case is GBRA-162's knowledge-update shape: an earlier
 * value sits in a low-scoring session that restates the same fact.
 */
import { describe, expect, test } from 'bun:test';
import type { SearchResult } from '../src/core/types.ts';
import { DEFAULT_AUTO_PACKING, deliverEvidence, resolveEvidencePlan, type EvidencePlan } from '../src/core/search/evidence-delivery.ts';
import { EVIDENCE_TAIL_TRIM_KEY, queryTerms } from '../src/core/search/evidence-tail-trim.ts';

const QUERY = 'What was my previous personal best time for the charity 5K run?';
const SESSIONS: Array<{ slug: string; score: number; text: string }> = [
  { slug: 'chat/s-1', score: 0.85, text: '**user:** I ran the charity 5K run again today and set a new personal best time of 25:50.' },
  { slug: 'chat/s-2', score: 0.32, text: '**user:** Can you suggest a stretching routine for my knees?' },
  { slug: 'chat/s-3', score: 0.30, text: '**user:** I want to plan meals for the week with more protein.' },
  { slug: 'chat/s-4', score: 0.29, text: '**user:** My personal best time in the charity 5K run is 27:45 so far.' },
  { slug: 'chat/s-5', score: 0.20, text: '**user:** Which pasta shape works best with a tomato sauce?' },
];

function stub(config: Record<string, string> = {}) {
  return {
    async getConfig(key: string) { return config[key] ?? null; },
    async executeRaw() { return []; },
    async getChunkWindows(requests: Array<{ page_id: number }>) {
      const ids = [...new Set(requests.map(r => r.page_id))];
      return ids.map(id => {
        const s = SESSIONS[id - 1];
        return { page_id: id, slug: s.slug, source_id: 'default', type: 'note', revision: `r${id}`, sealed: true, max_chunk_index: 0, row_limited: false,
          compiled_truth: s.text, timeline: '', chunks: [{ id: 100 + id, chunk_index: 0, chunk_text: s.text, chunk_source: 'compiled_truth' }] };
      });
    },
  } as never;
}

const hits = (rows = SESSIONS): SearchResult[] => rows.map((s, i) => ({ slug: s.slug, page_id: i + 1, title: `Session ${i + 1}`, type: 'note',
  chunk_text: s.text, chunk_source: 'compiled_truth', chunk_id: 101 + i, chunk_index: 0, score: s.score, stale: false, source_id: 'default' }));
const plan = (tailTrim: boolean): EvidencePlan => ({ requestedUnit: 'auto', unit: 'auto', window: 1, budgetTokens: 24000, explicitUnit: true,
  budgetExplicit: false, packing: DEFAULT_AUTO_PACKING, ...(tailTrim ? { tailTrim: true as const } : {}) });
const slugs = (rows: Array<{ slug: string }>) => rows.map(r => r.slug);

describe('evidence tail trim', () => {
  test('keeps the low-scoring session that restates the asked fact and drops the unrelated tail', async () => {
    const d = await deliverEvidence(stub(), hits(), plan(true), {}, { query: QUERY });
    expect(slugs(d.results)).toEqual(['chat/s-1', 'chat/s-2', 'chat/s-3', 'chat/s-4']);
    expect(d.delivery.tail_trim).toEqual({ dropped: 1, kept_by_query_terms: 1 });
    expect(d.delivery.dropped_reasons.tail_trim).toBe(1);
    expect(d.delivery.blocks).toBe(4);
  });

  test('the top 3 are protected and blocks at half of rank one or above stay', async () => {
    const rows = SESSIONS.map(s => s.score < 0.3 ? { ...s, score: 0.43 } : s);
    const d = await deliverEvidence(stub(), hits(rows), plan(true), {}, { query: 'Which pasta shape works with tomato sauce?' });
    expect(slugs(d.results)).toEqual(SESSIONS.map(s => s.slug));
    expect(d.delivery.tail_trim).toEqual({ dropped: 0, kept_by_query_terms: 0 });
    const cut = await deliverEvidence(stub(), hits(), plan(true), {}, { query: 'stretching routine for my knees' });
    expect(slugs(cut.results)).toEqual(['chat/s-1', 'chat/s-2', 'chat/s-3']);
    expect(cut.delivery.tail_trim).toEqual({ dropped: 2, kept_by_query_terms: 0 });
  });

  test('off by default, and without a query or usable scores it changes nothing', async () => {
    const off = await deliverEvidence(stub(), hits(), plan(false), {}, { query: QUERY });
    expect(slugs(off.results)).toEqual(SESSIONS.map(s => s.slug));
    expect(off.delivery.tail_trim).toBeUndefined();
    const noQuery = await deliverEvidence(stub(), hits(), plan(true), {});
    expect(slugs(noQuery.results)).toEqual(SESSIONS.map(s => s.slug));
    expect(noQuery.delivery.tail_trim).toBeUndefined();
    const unscored = await deliverEvidence(stub(), hits().map((h, i) => i === 4 ? { ...h, score: Number.NaN } : h), plan(true), {}, { query: 'stretching routine for my knees' });
    expect(slugs(unscored.results)).toEqual(SESSIONS.map(s => s.slug));
    expect(off.results.map(r => r.chunk_text)).toEqual(noQuery.results.map(r => r.chunk_text));
  });

  test('ranked chunks of non-conversation pages are never dropped', async () => {
    const rows = hits().map((h, i) => i === 4 ? { ...h, slug: 'notes/pasta' } : h);
    const d = await deliverEvidence(stub(), rows, plan(true), {}, { query: 'stretching routine for my knees' });
    expect(slugs(d.results)).toEqual(['chat/s-1', 'chat/s-2', 'chat/s-3', 'notes/pasta']);
    expect(d.results[3].delivered.unit).toBe('chunk');
  });

  test('the plan carries the trim only for auto with the key on', async () => {
    const on = stub({ [EVIDENCE_TAIL_TRIM_KEY]: 'true' });
    const base = { remote: false, returnWindow: undefined, budget: undefined, snippetChars: undefined, snippetCap: 0, op: 'query' as const };
    expect((await resolveEvidencePlan(on, { ...base, returnUnit: 'auto' }))?.tailTrim).toBe(true);
    expect((await resolveEvidencePlan(on, { ...base, returnUnit: 'page' }))?.tailTrim).toBeUndefined();
    expect((await resolveEvidencePlan(stub(), { ...base, returnUnit: 'auto' }))?.tailTrim).toBeUndefined();
  });

  test('query terms drop stopwords and single characters and cut words to six characters', () => {
    expect([...queryTerms(QUERY)].sort()).toEqual(['5k', 'best', 'charit', 'person', 'previo', 'run', 'time']);
    expect(queryTerms('a I of')).toEqual(new Set());
  });
});
