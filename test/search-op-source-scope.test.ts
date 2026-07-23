/**
 * #1484 follow-up — the `search` op must honor per-call `source_id` /
 * `all_sources` through the canonical fail-closed resolver
 * (resolveRequestedScope), exactly like `query` does.
 *
 * Pre-fix, `search` had no source_id param at all: the zero-hit CLI hint
 * advised "retry with --source-id __all__", the flag parsed into params,
 * NOTHING consumed it, and the retry silently re-ran the same single-source
 * search — an invisible false negative (and the retry's params.source_id
 * suppressed the hint, so the user got no second warning).
 */

import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const searchOp = operationsByName['search'];

/** Fake engine: keyword-only config so the handler's scope goes straight to
 *  searchKeyword, where we capture the opts it was called with. */
function makeCtx(remote: boolean, allowedSources?: string[]) {
  const captured: { opts?: Record<string, unknown> } = {};
  const engine = {
    getConfig: async (key: string) => (key === 'search.mcp_keyword_only' ? 'true' : null),
    searchKeyword: async (_q: string, opts: Record<string, unknown>) => {
      captured.opts = opts;
      return [];
    },
  } as unknown as BrainEngine;
  const ctx = {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote,
    sourceId: 'default',
    ...(allowedSources ? { auth: { allowedSources } } : {}),
  } as unknown as OperationContext;
  return { ctx, captured };
}

describe('search op per-call source scope (#1484 follow-up)', () => {
  test('op declares source_id + all_sources params (the CLI hint advises them)', () => {
    expect(searchOp.params.source_id).toBeDefined();
    expect(searchOp.params.all_sources).toBeDefined();
  });

  test('default: scopes to ctx.sourceId', async () => {
    const { ctx, captured } = makeCtx(false);
    await searchOp.handler(ctx, { query: 'x' });
    expect(captured.opts?.sourceId).toBe('default');
  });

  test("local + source_id '__all__' spans the whole brain (no source filter)", async () => {
    const { ctx, captured } = makeCtx(false);
    await searchOp.handler(ctx, { query: 'x', source_id: '__all__' });
    expect(captured.opts?.sourceId).toBeUndefined();
    expect(captured.opts?.sourceIds).toBeUndefined();
  });

  test('local + all_sources=true spans the whole brain', async () => {
    const { ctx, captured } = makeCtx(false);
    await searchOp.handler(ctx, { query: 'x', all_sources: true });
    expect(captured.opts?.sourceId).toBeUndefined();
    expect(captured.opts?.sourceIds).toBeUndefined();
  });

  test('explicit source_id wins over ctx.sourceId', async () => {
    const { ctx, captured } = makeCtx(false);
    await searchOp.handler(ctx, { query: 'x', source_id: 'wiki' });
    expect(captured.opts?.sourceId).toBe('wiki');
  });

  test("remote + '__all__' collapses to the caller's grant (fail-closed)", async () => {
    const { ctx, captured } = makeCtx(true, ['wiki', 'essays']);
    await searchOp.handler(ctx, { query: 'x', source_id: '__all__' });
    expect(captured.opts?.sourceIds).toEqual(['wiki', 'essays']);
  });

  test('remote + out-of-grant source_id is denied', async () => {
    const { ctx } = makeCtx(true, ['wiki']);
    await expect(searchOp.handler(ctx, { query: 'x', source_id: 'secrets' })).rejects.toThrow(
      /outside your granted sources/,
    );
  });
});
