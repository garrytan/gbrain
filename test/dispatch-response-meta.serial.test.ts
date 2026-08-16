/**
 * WP2/D3/D8 — the `_meta.retrieval` response channel and the model-visible
 * second content block on empty retrievals, driven through the REAL dispatch
 * path (dispatchToolCall → search op handler) with hybridSearchCached mocked.
 *
 * Pins the four load-bearing behaviors:
 *   1. empty results → bare-array body + SECOND text block (D8);
 *   2. `_meta.retrieval` present on empty AND non-empty responses (D3);
 *   3. a metaHook failure never drops the retrieval key (per-key isolation);
 *   4. metaHook keys merge ALONGSIDE retrieval, not over it.
 *
 * Serial: mock.module (isolation guard R2).
 */

import { describe, expect, mock, test } from 'bun:test';
import * as realHybrid from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let nextResults: unknown[] = [];
let nextMeta: Record<string, unknown> | null = null;

// Mock BEFORE importing dispatch (operations.ts binds hybridSearchCached at
// import time; the spread keeps every other export live).
mock.module('../src/core/search/hybrid.ts', () => ({
  ...realHybrid,
  hybridSearchCached: async (
    _engine: unknown,
    _query: string,
    opts: { onMeta?: (m: unknown) => void },
  ) => {
    if (nextMeta) opts.onMeta?.(nextMeta);
    return nextResults;
  },
}));

const { dispatchToolCall } = await import('../src/mcp/dispatch.ts');

const engineStub = {
  getConfig: async () => null,
  executeRaw: async () => [],
} as unknown as BrainEngine;

const DEGRADED_META = {
  vector_enabled: false,
  expansion_applied: false,
  detail_resolved: null,
  retrieved_count: 3,
  degraded: [{ stage: 'embed_unavailable' }],
};

function callSearch(metaHook?: () => Promise<Record<string, unknown> | undefined>) {
  return dispatchToolCall(engineStub, 'search', { query: 'anything at all' }, {
    remote: true,
    transport: 'http',
    sourceId: 'default',
    ...(metaHook ? { metaHook } : {}),
  });
}

describe('dispatch response meta (WP2/D3/D8)', () => {
  test('empty results → second content block + _meta.retrieval', async () => {
    nextResults = [];
    nextMeta = DEGRADED_META;
    const out = await callSearch();
    expect(out.isError).toBeUndefined();
    // Body block 0 stays the bare array (deployed thin-clients parse only this).
    expect(JSON.parse(out.content[0].text)).toEqual([]);
    // D8: the model-visible diagnosis block.
    expect(out.content.length).toBe(2);
    expect(out.content[1].text).toContain('0 results');
    expect(out.content[1].text).toContain('retrieved 3');
    expect(out.content[1].text).toContain('degraded: embed_unavailable');
    const retrieval = (out._meta as Record<string, any>).retrieval;
    expect(retrieval.returned_count).toBe(0);
    expect(retrieval.retrieved_count).toBe(3);
    expect(retrieval.degraded).toEqual([{ stage: 'embed_unavailable' }]);
  });

  test('clean miss → second block says clean miss, degraded absent', async () => {
    nextResults = [];
    nextMeta = { vector_enabled: true, expansion_applied: false, detail_resolved: null };
    const out = await callSearch();
    expect(out.content.length).toBe(2);
    expect(out.content[1].text).toContain('clean miss');
    const retrieval = (out._meta as Record<string, any>).retrieval;
    expect(retrieval.degraded).toBeUndefined();
    expect(retrieval.vector_enabled).toBe(true);
  });

  test('non-empty results → single block, _meta.retrieval still present (D3: on ALL responses)', async () => {
    nextResults = [{ page_id: 1, slug: 'a', chunk_text: 'x' }];
    nextMeta = DEGRADED_META;
    const out = await callSearch();
    expect(out.content.length).toBe(1);
    const retrieval = (out._meta as Record<string, any>).retrieval;
    expect(retrieval.returned_count).toBe(1);
  });

  test('metaHook failure never drops the retrieval key (per-key isolation)', async () => {
    nextResults = [];
    nextMeta = DEGRADED_META;
    const out = await callSearch(async () => { throw new Error('hot memory down'); });
    expect((out._meta as Record<string, any>).retrieval).toBeDefined();
  });

  test('metaHook keys merge alongside retrieval, not over it', async () => {
    nextResults = [];
    nextMeta = DEGRADED_META;
    const out = await callSearch(async () => ({ brain_hot_memory: { facts: [] } }));
    const meta = out._meta as Record<string, any>;
    expect(meta.retrieval).toBeDefined();
    expect(meta.brain_hot_memory).toEqual({ facts: [] });
  });
});

describe('buildEmptyRetrievalBlock (unit)', () => {
  test('hint passthrough + stage dedupe + garbage tolerance', async () => {
    const { buildEmptyRetrievalBlock } = await import('../src/mcp/dispatch.ts');
    const text = buildEmptyRetrievalBlock({
      retrieved_count: 5,
      degraded: [{ stage: 'embed_timeout' }, { stage: 'embed_timeout' }, { stage: 'budget_dropped_all' }],
      hint: 'try the query tool.',
    });
    expect(text).toContain('retrieved 5');
    expect(text).toContain('degraded: embed_timeout, budget_dropped_all');
    expect(text).toContain('hint: try the query tool.');
    expect((text!.match(/embed_timeout/g) ?? []).length).toBe(1);
    expect(buildEmptyRetrievalBlock(null)).toBeNull();
    expect(buildEmptyRetrievalBlock('nope')).toBeNull();
  });
});
