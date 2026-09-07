/**
 * #4400 — list_pages had no source-scoping param at all: it silently
 * ignored `source_id`/`source_ids` and always fell back to whatever
 * federatedSearchScope() resolved from ctx alone. get_stats aggregates
 * across every source; list_pages could never enumerate a non-federated
 * source's pages remotely, no matter the limit.
 *
 * This asserts list_pages now honors an explicit per-call `source_id`,
 * including the '__all__' sentinel, exactly like search/query already do.
 */
import { describe, test, expect } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

const list_pages = operations.find(o => o.name === 'list_pages')!;

function makeCtx(overrides: Partial<OperationContext> = {}): {
  ctx: OperationContext;
  calls: any[];
} {
  const calls: any[] = [];
  const ctx = {
    engine: {
      listPages: async (opts: any) => {
        calls.push(opts);
        return [];
      },
      // #4620: an explicit source_id is checked against the live registry
      // (a point lookup on `sources`; every id this file names is live).
      executeRaw: async () => [{ ok: 1 }],
    } as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
  return { ctx, calls };
}

describe('list_pages — explicit source_id param (#4400)', () => {
  test('an explicit source_id scopes the engine call to that source', async () => {
    const { ctx, calls } = makeCtx({ sourceId: 'default' });
    await list_pages.handler(ctx, { source_id: 'hermes-coding-agent' });
    expect(calls[0]).toMatchObject({ sourceId: 'hermes-coding-agent' });
  });

  test("'__all__' spans every source for a trusted local caller (empty scope)", async () => {
    const { ctx, calls } = makeCtx({ remote: false, sourceId: 'default' });
    await list_pages.handler(ctx, { source_id: '__all__' });
    expect(calls[0].sourceId).toBeUndefined();
    expect(calls[0].sourceIds).toBeUndefined();
  });

  test("'__all__' for a remote caller with a multi-source grant spans only granted sources", async () => {
    const { ctx, calls } = makeCtx({
      remote: true,
      sourceId: 'default',
      auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['a', 'b'] } as any,
    });
    await list_pages.handler(ctx, { source_id: '__all__' });
    expect(calls[0]).toMatchObject({ sourceIds: ['a', 'b'] });
  });

  test('a remote caller requesting an out-of-grant source_id is denied', async () => {
    const { ctx } = makeCtx({
      remote: true,
      sourceId: 'default',
      auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['a'] } as any,
    });
    await expect(list_pages.handler(ctx, { source_id: 'b' })).rejects.toThrow(
      /outside your granted sources/,
    );
  });

  test('no source_id param still falls back to federatedSearchScope(ctx) (back-compat)', async () => {
    const { ctx, calls } = makeCtx({
      remote: false,
      sourceId: 'default',
      localFederatedSourceIds: ['default', 'src-a', 'src-b'],
    });
    await list_pages.handler(ctx, {});
    expect(calls[0]).toMatchObject({ sourceIds: ['default', 'src-a', 'src-b'] });
  });
});

describe('list_pages — source_id is parsed like get_page (#4857)', () => {
  // Pre-fix the handler took any string through as-is: a whitespace or
  // malformed id reached the engine and silently returned [], a non-string
  // was dropped (unscoped listing), and the CLI's `--source-id ""` silently
  // widened to every source. parseSourceIdParam rejects all of them loudly.
  test('whitespace, malformed, non-string, and empty source_id are invalid_params before the engine is called', async () => {
    for (const source_id of ['   ', 'not valid!', 42, '']) {
      const { ctx, calls } = makeCtx({ remote: false });
      await expect(list_pages.handler(ctx, { source_id })).rejects.toMatchObject({ code: 'invalid_params' });
      expect(calls).toHaveLength(0);
    }
  });
});
