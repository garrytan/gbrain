/**
 * #4356 Site 1 — the `query` op's text/hybrid path (src/core/ops/search.ts)
 * was a hard `(p.limit as number) || 20`, independent of the resolved
 * search mode's `searchLimit` (10/25/50 for conservative/balanced/
 * tokenmax). Now `(p.limit as number) || undefined` — an omitted OR falsy
 * (`0`) `limit` lets hybridSearchCached's own mode-resolution apply instead
 * of being silently overridden to a flat 20.
 *
 * `0` is deliberately folded into "unset" here rather than forwarded as a
 * literal "return zero rows" request: `resolveSearchMode` (mode.ts) folds a
 * *forwarded* `opts.limit: 0` into `resolvedMode.searchLimit` itself (the
 * `perCall.searchLimit` pick treats 0 as a set value, not undefined), so a
 * bare hybridSearch/hybridSearchCached caller who passes `limit: 0` today
 * already gets zero rows end-to-end on both the miss and (after this PR's
 * Site 2 fix, see test/hybrid-cache-hit-limit-honors-mode.serial.test.ts)
 * the hit path. This op deliberately does NOT forward that 0 — matching
 * every other limit surface in this file (`search`'s own limit, the image-
 * similarity branch, `search_by_image`), none of which support a literal
 * empty-result request today. Introducing that capability only on this one
 * path would be a new, undocumented asymmetry — out of scope for a limit-
 * CONSISTENCY fix.
 *
 * Companion to #4356 Site 2 (see the sibling cache-hit test file). Fixing
 * both sites in the same PR is the point: shipping only this miss-path fix
 * would make the miss/hit inconsistency newly OBSERVABLE (previously both
 * were wrong at a flat 20, so they agreed) without resolving it — a
 * maintainer-lens review rejected exactly that partial shape when it shipped
 * split across two closed PRs (#4355, #4357).
 *
 * Driven through the REAL dispatch path (dispatchToolCall → query op
 * handler) with hybridSearchCached mocked, same pattern as
 * dispatch-response-meta.serial.test.ts.
 *
 * Serial: mock.module (isolation guard R2).
 */

import { describe, expect, mock, test } from 'bun:test';
import * as realHybrid from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let nextResults: unknown[] = [];
let capturedOpts: { limit?: number } | null = null;

// Mock BEFORE importing dispatch (operations.ts binds hybridSearchCached at
// import time; the spread keeps every other export live).
mock.module('../src/core/search/hybrid.ts', () => ({
  ...realHybrid,
  hybridSearchCached: async (
    _engine: unknown,
    _query: string,
    opts: { limit?: number; onMeta?: (m: unknown) => void },
  ) => {
    capturedOpts = opts;
    opts.onMeta?.({ vector_enabled: true, expansion_applied: false, detail_resolved: null });
    return nextResults;
  },
}));

const { dispatchToolCall } = await import('../src/mcp/dispatch.ts');

const engineStub = {
  getConfig: async () => null,
  executeRaw: async () => [],
} as unknown as BrainEngine;

function callQuery(params: Record<string, unknown>) {
  return dispatchToolCall(engineStub, 'query', { query: 'who founded acme-example', ...params }, {
    remote: true,
    transport: 'http',
    sourceId: 'default',
  });
}

describe('query op — text-path limit no longer hard-floors to 20 (#4356 Site 1)', () => {
  test('caller omits `limit` → hybridSearchCached receives limit: undefined (mode bundle decides)', async () => {
    nextResults = [];
    capturedOpts = null;
    await callQuery({});
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.limit).toBeUndefined();
  });

  test('caller passes an explicit positive numeric `limit` → still wins', async () => {
    nextResults = [];
    capturedOpts = null;
    await callQuery({ limit: 7 });
    expect(capturedOpts!.limit).toBe(7);
  });

  test('caller passes `limit: 0` → op forwards undefined (0 is treated as unset, not as "return zero rows")', async () => {
    nextResults = [];
    capturedOpts = null;
    await callQuery({ limit: 0 });
    expect(capturedOpts!.limit).toBeUndefined();
  });
});
