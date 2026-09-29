/**
 * Read-path audit #13: DEFAULT_SOURCE_BOOSTS fit one vault layout and were
 * only overridable per process (GBRAIN_SOURCE_BOOST). A brain can now carry
 * its own map in `search.source_boosts` (same `prefix:factor,...` format;
 * a `none` entry drops the defaults). Existing brains keep the defaults.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { DEFAULT_SOURCE_BOOSTS, resolveBoostMap } from '../../src/core/search/source-boost.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { installPageProjection, readProjectionSnapshot } from '../../src/core/page-state/projections.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';

describe('resolveBoostMap with a per-brain config value', () => {
  test('no config keeps the defaults', () => {
    expect(resolveBoostMap(undefined, undefined)).toEqual(DEFAULT_SOURCE_BOOSTS);
  });
  test('config entries override and extend the defaults', () => {
    const m = resolveBoostMap(undefined, 'people/:1.0,wiki/:1.3');
    expect(m['people/']).toBe(1.0);
    expect(m['wiki/']).toBe(1.3);
    expect(m['originals/']).toBe(DEFAULT_SOURCE_BOOSTS['originals/']);
  });
  test('a none entry drops the defaults', () => {
    expect(resolveBoostMap(undefined, 'none')).toEqual({});
    expect(resolveBoostMap(undefined, 'none,wiki/:1.3')).toEqual({ 'wiki/': 1.3 });
  });
  test('the env override still wins over the brain config', () => {
    expect(resolveBoostMap('wiki/:2', 'wiki/:1.3')['wiki/']).toBe(2);
  });
});

describe('search.source_boosts reaches the engine arms', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  async function seed(slug: string, text: string) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: text } as any);
    const snap = (await readProjectionSnapshot(engine, slug, 'default', { allowUnsealed: true }))!;
    await installPageProjection(engine, snap, [{
      chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', embedding: basisEmbedding(3, 1536), token_count: 5,
    }] as any, { seal: true });
  }
  const opts = { reranker: { enabled: false, topNIn: 0, topNOut: null } as any, queryEmbedFn: () => basisEmbedding(3, 1536) };

  test('a brain-level map re-orders pages the default map would order the other way', async () => {
    await seed('daily/2026-01-01', 'widget pricing review notes');
    await seed('people/alice-example', 'widget pricing review notes');
    const before = await hybridSearch(engine, 'widget pricing review', opts);
    expect(before[0].slug).toBe('people/alice-example');
    await engine.setConfig('search.source_boosts', 'daily/:1.5');
    const after = await hybridSearch(engine, 'widget pricing review', opts);
    expect(after[0].slug).toBe('daily/2026-01-01');
    const kw = await engine.searchKeyword('widget pricing review', { source_boosts: resolveBoostMap(undefined, 'daily/:1.5') });
    expect(kw[0].slug).toBe('daily/2026-01-01');
  }, 60_000);
});
