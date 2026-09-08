/**
 * `list_pages` op params → engine filters.
 *
 * The engines have carried `slugPrefix` and `updatedAfterKeyset` for a while
 * and now carry `frontmatterEq`, but a filter that no op param maps to is
 * unreachable for every agent-facing caller. Worse, a param DECLARED on the op
 * and never mapped in the handler is not a missing feature — it is a silent
 * lie: the caller passes it, gets a 200 and the whole unfiltered listing back,
 * and nothing anywhere says the filter was dropped.
 *
 * These tests assert on what reaches `engine.listPages`, with a stub engine
 * capturing the opts (same pattern as list-pages-source-scope.test.ts). The
 * engine-level SQL is pinned separately by list-pages-frontmatter-filter,
 * list-pages-slug-total-order and list-pages-updated-asc-total-order.
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

describe('list_pages — frontmatter_key / frontmatter_value', () => {
  test('both params reach the engine as frontmatterEq', async () => {
    const { ctx, calls } = makeCtx();
    await list_pages.handler(ctx, { frontmatter_key: 'status', frontmatter_value: 'active' });
    expect(calls[0].frontmatterEq).toEqual({ key: 'status', value: 'active' });
  });

  test('an empty-string value is a real filter, not an absent one', async () => {
    // `status: ""` in frontmatter is a value a caller can legitimately want to
    // find. Treating it as unset would silently return the whole listing.
    const { ctx, calls } = makeCtx();
    await list_pages.handler(ctx, { frontmatter_key: 'status', frontmatter_value: '' });
    expect(calls[0].frontmatterEq).toEqual({ key: 'status', value: '' });
  });

  test('either param alone is ignored rather than half-applied', async () => {
    const a = makeCtx();
    await list_pages.handler(a.ctx, { frontmatter_key: 'status' });
    expect(a.calls[0].frontmatterEq).toBeUndefined();

    const b = makeCtx();
    await list_pages.handler(b.ctx, { frontmatter_value: 'active' });
    expect(b.calls[0].frontmatterEq).toBeUndefined();
  });

  test('no frontmatter params → no frontmatter filter', async () => {
    const { ctx, calls } = makeCtx();
    await list_pages.handler(ctx, {});
    expect(calls[0].frontmatterEq).toBeUndefined();
  });
});

describe('list_pages — slug_prefix', () => {
  test('reaches the engine as slugPrefix', async () => {
    const { ctx, calls } = makeCtx();
    await list_pages.handler(ctx, { slug_prefix: 'notes/meetings/' });
    expect(calls[0].slugPrefix).toBe('notes/meetings/');
  });

  test('an empty prefix is not a filter (it would match everything)', async () => {
    const { ctx, calls } = makeCtx();
    await list_pages.handler(ctx, { slug_prefix: '' });
    expect(calls[0].slugPrefix).toBeUndefined();
  });
});

describe('list_pages — updated_after_slug keyset', () => {
  test('paired with updated_after it becomes the keyset cursor and forces updated_asc', async () => {
    const { ctx, calls } = makeCtx();
    await list_pages.handler(ctx, {
      updated_after: '2026-08-10T12:00:00.000123Z',
      updated_after_slug: 'notes/b',
    });
    expect(calls[0].updatedAfterKeyset).toEqual({
      updatedAt: '2026-08-10T12:00:00.000123Z',
      slug: 'notes/b',
    });
    // The bare filter must not ALSO apply, or the cursor's tie-bucket resume
    // would be cut off by `updated_at > ts`.
    expect(calls[0].updated_after).toBeUndefined();
    expect(calls[0].sort).toBe('updated_asc');
  });

  test('an empty slug is the start of the timestamp bucket, not an absent cursor', async () => {
    const { ctx, calls } = makeCtx();
    await list_pages.handler(ctx, { updated_after: '2026-08-10T12:00:00Z', updated_after_slug: '' });
    expect(calls[0].updatedAfterKeyset).toEqual({ updatedAt: '2026-08-10T12:00:00Z', slug: '' });
  });

  test('updated_after alone keeps the pre-existing bare filter and the requested sort', async () => {
    const { ctx, calls } = makeCtx();
    await list_pages.handler(ctx, { updated_after: '2026-08-10', sort: 'slug' });
    expect(calls[0].updated_after).toBe('2026-08-10');
    expect(calls[0].updatedAfterKeyset).toBeUndefined();
    expect(calls[0].sort).toBe('slug');
  });

  test('a keyset slug without updated_after has no timestamp to resume from and is ignored', async () => {
    const { ctx, calls } = makeCtx();
    await list_pages.handler(ctx, { updated_after_slug: 'notes/b' });
    expect(calls[0].updatedAfterKeyset).toBeUndefined();
  });

  test('an empty updated_after is not a cursor — `\'\'::timestamptz` is a cast error', async () => {
    const { ctx, calls } = makeCtx();
    await list_pages.handler(ctx, { updated_after: '', updated_after_slug: 'notes/b' });
    expect(calls[0].updatedAfterKeyset).toBeUndefined();
  });
});

describe('list_pages — the new filters compose with the existing ones', () => {
  test('type, source scope and the three new filters all survive together', async () => {
    const { ctx, calls } = makeCtx({ remote: false, sourceId: 'default' });
    await list_pages.handler(ctx, {
      type: 'note',
      slug_prefix: 'notes/',
      frontmatter_key: 'channel_id',
      frontmatter_value: 'C0EXAMPLE1',
      source_id: '__all__',
    });
    expect(calls[0]).toMatchObject({
      type: 'note',
      slugPrefix: 'notes/',
      frontmatterEq: { key: 'channel_id', value: 'C0EXAMPLE1' },
    });
    expect(calls[0].sourceId).toBeUndefined();
  });
});
