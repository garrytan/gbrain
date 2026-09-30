/**
 * Read-path audit #6: the exact-match intent boost only fired when the whole
 * query equalled a title or slug, but entity intent is DEFINED by framing
 * words ("who is …"), so it never fired. A title, slug tail or declared alias
 * mentioned inside the query now fires the same bounded boost.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { isTitleMentionedInQuery } from '../../src/core/search/title-match.ts';
import {
  aliasMentionCandidates,
  applyAliasMentionBoost,
  applyExactMatchBoost,
  weightsForIntent,
} from '../../src/core/search/intent-weights.ts';
import { classifyQuery } from '../../src/core/search/query-intent.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';
import { installPageProjection, readProjectionSnapshot } from '../../src/core/page-state/projections.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';

const row = (slug: string, title: string, score = 1): SearchResult => ({
  slug, title, page_id: 1, type: 'person', chunk_text: title, chunk_source: 'compiled_truth',
  chunk_id: 1, chunk_index: 0, score, stale: false, source_id: 'default',
} as SearchResult);

describe('isTitleMentionedInQuery', () => {
  test('a multi-token title inside a framed question', () => {
    expect(isTitleMentionedInQuery('who is Alice Example', 'Alice Example')).toBe(true);
    expect(isTitleMentionedInQuery('tell me about Acme Widget Co', 'Acme Widget Co')).toBe(true);
    expect(isTitleMentionedInQuery('what did alice-example say?', 'Alice Example')).toBe(true);
  });

  test('token boundaries, not substrings; order matters', () => {
    expect(isTitleMentionedInQuery('who is Alice Examples', 'Alice Example')).toBe(false);
    expect(isTitleMentionedInQuery('who is Example Alice', 'Alice Example')).toBe(false);
    expect(isTitleMentionedInQuery('Alice', 'Alice Example')).toBe(false);
  });

  test('generic titles are guarded', () => {
    expect(isTitleMentionedInQuery('what is the plan of the day', 'The')).toBe(false);
    expect(isTitleMentionedInQuery('who is bob', 'Bob')).toBe(false);
    expect(isTitleMentionedInQuery('tell me about Mingtang', 'Mingtang')).toBe(true);
  });
});

describe('applyExactMatchBoost fires on a mentioned title', () => {
  test('"who is Alice Example" boosts page "Alice Example" under entity intent', () => {
    const q = 'who is Alice Example';
    expect(classifyQuery(q).intent).toBe('entity');
    const results = [row('people/alice-example', 'Alice Example'), row('people/charlie-example', 'Charlie Example')];
    applyExactMatchBoost(results, q, weightsForIntent('entity'));
    expect(results[0].score).toBe(1.25);
    expect(results[0].exact_match_boost).toBe(1.25);
    expect(results[1].score).toBe(1);
  });

  test('the slug tail counts too', () => {
    const results = [row('people/alice-example', 'AE')];
    applyExactMatchBoost(results, 'tell me about alice example', weightsForIntent('entity'));
    expect(results[0].score).toBe(1.25);
  });

  test('general intent stays a no-op', () => {
    const results = [row('people/alice-example', 'Alice Example')];
    applyExactMatchBoost(results, 'Alice Example notes', weightsForIntent('general'));
    expect(results[0].score).toBe(1);
  });
});

describe('applyAliasMentionBoost', () => {
  test('n-gram candidates skip short single tokens', () => {
    const c = aliasMentionCandidates('who is the Hall of Light');
    expect(c).toContain('hall of light');
    expect(c).toContain('light');
    expect(c).not.toContain('who');
    expect(c).not.toContain('is');
  });

  test('a page whose alias is mentioned in the query gets the boost once', async () => {
    const results = [row('places/mingtang', 'Mingtang'), row('places/other', 'Other Place')];
    const seen: string[][] = [];
    await applyAliasMentionBoost(results, 'tell me about the hall of light', weightsForIntent('entity'), async (aliases) => {
      seen.push(aliases);
      return new Map([['hall of light', [{ slug: 'places/mingtang', source_id: 'default' }]]]);
    });
    expect(seen[0]).toContain('hall of light');
    expect(results[0].score).toBe(1.25);
    expect(results[1].score).toBe(1);
    // Already boosted by the title path → not boosted twice.
    const again = [row('places/mingtang', 'Mingtang')];
    applyExactMatchBoost(again, 'tell me about mingtang, the hall of light', weightsForIntent('entity'));
    await applyAliasMentionBoost(again, 'tell me about mingtang, the hall of light', weightsForIntent('entity'), async () =>
      new Map([['hall of light', [{ slug: 'places/mingtang', source_id: 'default' }]]]));
    expect(again[0].score).toBe(1.25);
  });

  test('resolver failure is fail-open', async () => {
    const results = [row('places/mingtang', 'Mingtang')];
    await applyAliasMentionBoost(results, 'tell me about the hall of light', weightsForIntent('entity'), async () => { throw new Error('no table'); });
    expect(results[0].score).toBe(1);
  });
});

describe('framed entity query ranks the named page first (PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  async function seed(slug: string, title: string, text: string, dim: number) {
    await engine.putPage(slug, { type: 'person', title, compiled_truth: text } as any);
    const snap = (await readProjectionSnapshot(engine, slug, 'default', { allowUnsealed: true }))!;
    await installPageProjection(engine, snap, [{
      chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', embedding: basisEmbedding(dim, 1536), token_count: 10,
    }] as any, { seal: true });
  }

  test('"who is Alice Example": the Alice Example page outranks a closer-embedded neighbour', async () => {
    await seed('people/alice-example', 'Alice Example', 'Alice Example runs the widget lab and mentors founders.', 5);
    await seed('people/charlie-example', 'Charlie Example', 'Charlie Example works with Alice Example on the widget lab.', 6);
    const out = await hybridSearch(engine, 'who is Alice Example', {
      queryEmbedFn: () => basisEmbedding(6, 1536),
      reranker: { enabled: false, topNIn: 0, topNOut: null } as any,
    });
    expect(out[0].slug).toBe('people/alice-example');
    expect(out[0].exact_match_boost).toBe(1.25);
  }, 60_000);
});
