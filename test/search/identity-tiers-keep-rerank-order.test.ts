/**
 * The alias hop and the exact-lookup tier run AFTER the reranker. `score` on a
 * reranked row is still the fusion score, so a global re-sort by `score`
 * threw away the cross-encoder order. Both tiers must place identity rows and
 * leave every other row in its input (reranked) order.
 */
import { describe, test, expect } from 'bun:test';
import { applyExactLookupTier } from '../../src/core/search/exact-lookup.ts';
import { applyAliasHop } from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';

const mk = (slug: string, score: number, rerank?: number): SearchResult => ({
  slug, page_id: slug.length, title: slug, type: 'note', source_id: 'default',
  chunk_id: Math.round(score * 1000), chunk_index: 0, chunk_text: slug, chunk_source: 'compiled_truth',
  score, stale: false, ...(rerank === undefined ? {} : { rerank_score: rerank }),
} as SearchResult);

const noLinksEngine: any = { executeRaw: async () => { throw new Error('no'); }, getLinksByType: async () => [] };
const aliasEngine = (alias: string, slug: string): any => ({
  resolveAliases: async () => new Map([[alias, [{ slug, source_id: 'default' }]]]),
  getPage: async () => ({ id: 99, slug, title: slug, type: 'note', source_id: 'default', compiled_truth: 'body', frontmatter: {} }),
});

describe('identity tiers keep the reranker order', () => {
  test('exact-title tier: identity row first, the rest in reranked order', async () => {
    const reranked = [mk('c', 0.3, 0.95), mk('b', 0.5, 0.6), mk('a', 0.9, 0.1), mk('acme widget', 0.2, 0.05)];
    const out = await applyExactLookupTier(noLinksEngine, reranked, 'Acme Widget', { titleCandidates: [mk('acme widget', 0.2, 0.05)] });
    expect(out[0].slug).toBe('acme widget');
    expect(out[0].exact_lookup).toBe('title');
    expect(out.slice(1).map(r => r.slug)).toEqual(['c', 'b', 'a']);
  });

  test('exact-title tier injecting an absent page keeps the rest in reranked order', async () => {
    const reranked = [mk('c', 0.3, 0.95), mk('b', 0.5, 0.6), mk('a', 0.9, 0.1)];
    const out = await applyExactLookupTier(noLinksEngine, reranked, 'Acme Widget', { titleCandidates: [mk('acme widget', 0.2)] });
    expect(out.map(r => r.slug)).toEqual(['acme widget', 'c', 'b', 'a']);
    expect(out[0].score).toBeGreaterThan(0.9);
  });

  test('alias hop on the reranker #1 keeps it #1 and the rest in reranked order', async () => {
    const reranked = [mk('c', 0.3, 0.95), mk('b', 0.5, 0.6), mk('a', 0.9, 0.1)];
    const out = await applyAliasHop(aliasEngine('c', 'c'), reranked, 'c', {});
    expect(out.map(r => r.slug)).toEqual(['c', 'b', 'a']);
    expect(out[0].alias_hit).toBe(true);
  });

  test('alias hop on a mid-list row never reorders the non-identity rows', async () => {
    const reranked = [mk('c', 0.3, 0.95), mk('b', 0.5, 0.6), mk('d', 0.1, 0.2), mk('a', 0.9, 0.1)];
    const out = await applyAliasHop(aliasEngine('d', 'd'), reranked, 'd', {});
    expect(out.filter(r => r.slug !== 'd').map(r => r.slug)).toEqual(['c', 'b', 'a']);
  });

  test('alias hop injecting an absent page puts it first, the rest in reranked order', async () => {
    const reranked = [mk('c', 0.3, 0.95), mk('b', 0.5, 0.6), mk('a', 0.9, 0.1)];
    const out = await applyAliasHop(aliasEngine('zeta', 'zeta'), reranked, 'zeta', {});
    expect(out.map(r => r.slug)).toEqual(['zeta', 'c', 'b', 'a']);
    expect(out[0].score).toBeGreaterThan(0.9);
  });

  test('score-ordered (un-reranked) input: the 1.10x present boost still climbs past lower scores', async () => {
    const fused = [mk('a', 0.9), mk('b', 0.5), mk('c', 0.48), mk('d', 0.1)];
    const out = await applyAliasHop(aliasEngine('c', 'c'), fused, 'c', {});
    expect(out.map(r => r.slug)).toEqual(['a', 'c', 'b', 'd']);
  });
});
