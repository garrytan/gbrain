/**
 * `search.diverse_pool_depth` (GBRA-60 S1): range contract, config parse,
 * set-time refusal, bundle defaults, cache-key segregation and the
 * one-row-per-session cap. The hybridSearch wiring is pinned by
 * diverse-pool-hybrid.serial.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { DIVERSE_POOL_DEPTH_MAX, capPerSession, normalizeDiversePoolDepth } from '../../src/core/search/diverse-pool.ts';
import { MODE_BUNDLES, knobsHash, loadOverridesFromConfig, resolveSearchMode } from '../../src/core/search/mode.ts';
import { searchConfigValueRefusal } from '../../src/core/search/config-values.ts';
import type { SearchResult } from '../../src/core/types.ts';

const row = (slug: string, score: number, source_id = 'default', chunk_id = Math.round(score * 1000)): SearchResult =>
  ({ slug, score, source_id, chunk_id, page_id: 1, title: slug, type: 'note', chunk_text: slug, chunk_source: 'compiled_truth', stale: false } as SearchResult);

describe('normalizeDiversePoolDepth', () => {
  test('integers 0..100 and off; everything else falls through', () => {
    expect(normalizeDiversePoolDepth('0')).toBe(0);
    expect(normalizeDiversePoolDepth('100')).toBe(100);
    expect(normalizeDiversePoolDepth(40)).toBe(40);
    expect(normalizeDiversePoolDepth('off')).toBe(0);
    expect(normalizeDiversePoolDepth(false)).toBe(0);
    expect(DIVERSE_POOL_DEPTH_MAX).toBe(100);
    for (const bad of ['101', '-1', '2.5', '', 'many', null, undefined, true]) expect(normalizeDiversePoolDepth(bad)).toBeUndefined();
  });

  test('gbrain config set refuses an out-of-contract value and names a valid one', () => {
    expect(searchConfigValueRefusal('search.diverse_pool_depth', '100')).toBeNull();
    expect(searchConfigValueRefusal('search.diverse_pool_depth', 'off')).toBeNull();
    const refusal = searchConfigValueRefusal('search.diverse_pool_depth', '500');
    expect(refusal?.message).toContain('integer from 0 to 100');
    expect(refusal?.example).toBe('100');
  });
});

describe('diverse_pool_depth mode knob', () => {
  test('off in every bundle', () => {
    for (const m of ['conservative', 'balanced', 'tokenmax'] as const) expect(MODE_BUNDLES[m].diverse_pool_depth).toBe(0);
  });

  test('config parses into the override; garbage falls through to the bundle', () => {
    expect(loadOverridesFromConfig({ 'search.diverse_pool_depth': '100' }).diverse_pool_depth).toBe(100);
    expect(loadOverridesFromConfig({ 'search.diverse_pool_depth': 'off' }).diverse_pool_depth).toBe(0);
    expect(loadOverridesFromConfig({ 'search.diverse_pool_depth': '101' }).diverse_pool_depth).toBeUndefined();
    expect(resolveSearchMode({ mode: 'balanced', overrides: { diverse_pool_depth: 60 } }).diverse_pool_depth).toBe(60);
  });

  test('knobsHash: off keeps every existing key; a depth segregates the cache', () => {
    const dflt = knobsHash(resolveSearchMode({ mode: 'balanced' }));
    const explicitOff = knobsHash(resolveSearchMode({ mode: 'balanced', overrides: { diverse_pool_depth: 0 } }));
    const on = knobsHash(resolveSearchMode({ mode: 'balanced', overrides: { diverse_pool_depth: 100 } }));
    const on60 = knobsHash(resolveSearchMode({ mode: 'balanced', overrides: { diverse_pool_depth: 60 } }));
    expect(explicitOff).toBe(dflt);
    expect(new Set([dflt, on, on60]).size).toBe(3);
  });
});

describe('capPerSession', () => {
  test('keeps the first row per page when slugs are not session-shaped', () => {
    const out = capPerSession([row('notes/a', 0.9, 'default', 1), row('notes/a', 0.8, 'default', 2), row('notes/b', 0.7), row('notes/a', 0.6, 'default', 3)]);
    expect(out.map(r => [r.slug, r.chunk_id])).toEqual([['notes/a', 1], ['notes/b', 700]]);
  });

  test('pages of one recorded session share one slot; other sessions and sources keep theirs', () => {
    const out = capPerSession([
      row('media/chat/2026-05-20-standup/part-1', 0.9),
      row('media/chat/2026-05-20-standup/part-2', 0.85),
      row('chat/1m-3-s7', 0.8),
      row('chat/1m-3-s8', 0.75),
      row('media/chat/2026-05-20-standup/part-1', 0.7, 'work'),
    ]);
    expect(out.map(r => `${r.source_id}:${r.slug}`)).toEqual([
      'default:media/chat/2026-05-20-standup/part-1', 'default:chat/1m-3-s7', 'default:chat/1m-3-s8', 'work:media/chat/2026-05-20-standup/part-1',
    ]);
  });
});
