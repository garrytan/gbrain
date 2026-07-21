import { describe, test, expect } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';

/**
 * #2876: `gbrain list --limit` silently clamped at 100 with no pagination.
 * list_pages now declares `offset` (both engines already supported it on
 * PageFilters) and the limit description discloses the 100-row cap.
 */
describe('list_pages pagination (#2876)', () => {
  const listPagesOp = operationsByName.list_pages;

  function makeCtx(captured: unknown[]) {
    return {
      engine: {
        listPages: async (filters: unknown) => {
          captured.push(filters);
          return [];
        },
      },
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
    } as any;
  }

  test('declares offset param and discloses the 100-row cap on limit', () => {
    expect(listPagesOp.params.offset).toBeDefined();
    expect(listPagesOp.params.offset.type).toBe('number');
    expect(listPagesOp.params.limit.description).toContain('100');
  });

  test('threads offset through to engine.listPages', async () => {
    const captured: any[] = [];
    await listPagesOp.handler(makeCtx(captured), { limit: 10, offset: 30 });
    expect(captured[0].offset).toBe(30);
    expect(captured[0].limit).toBe(10);
  });

  test('drops negative, non-finite, and zero offsets', async () => {
    const captured: any[] = [];
    const ctx = makeCtx(captured);
    await listPagesOp.handler(ctx, { offset: -5 });
    await listPagesOp.handler(ctx, { offset: Infinity });
    await listPagesOp.handler(ctx, { offset: 0 });
    for (const f of captured) expect(f.offset).toBeUndefined();
  });

  test('floors fractional offsets', async () => {
    const captured: any[] = [];
    await listPagesOp.handler(makeCtx(captured), { offset: 7.9 });
    expect(captured[0].offset).toBe(7);
  });
});
