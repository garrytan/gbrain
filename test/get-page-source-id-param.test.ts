/**
 * Regression guard for get_page source_id parameter handling.
 *
 * Background: prior to this PR, get_page ignored the per-call source_id
 * parameter entirely — only OperationContext.sourceId was respected.
 * MCP clients with a default-source bearer (e.g. a write-scoped client
 * with source_id=default) could not get_page pages in non-default
 * sources, even when federated_read access was granted. The query-tool already
 * supported per-call source_id via the --source-id flag; this PR brings
 * get_page into symmetry with that.
 *
 * Covers:
 *   - get_page with explicit p.source_id overrides ctx.sourceId
 *   - get_page without p.source_id falls back to ctx.sourceId (backwards compat)
 *   - get_page with neither falls back to cross-source view (v0.31.8 behavior)
 *   - fuzzy resolution honors the explicit source_id (not just first call)
 */

import { describe, test, expect } from 'bun:test';
import { operations, type OperationContext } from '../src/core/operations.ts';

const STUB_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const STUB_CONFIG = {} as unknown as Parameters<typeof operations[number]['handler']>[0]['config'];

function findOp(name: string) {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(`operation ${name} not found`);
  return op;
}

/**
 * Engine stub that records every getPage call's sourceId option,
 * so tests can assert which source the handler dispatched to.
 *
 * Returns a fake page only when the requested source matches the
 * configured `pagesBySource` map, so we can verify that the right
 * lookup is happening (not just that the option is threaded).
 */
function recordingEngine(pagesBySource: Record<string, string[]>) {
  const calls: Array<{ slug: string; sourceId?: string; includeDeleted?: boolean }> = [];
  return {
    calls,
    engine: {
      getPage: async (slug: string, opts: { sourceId?: string; includeDeleted?: boolean }) => {
        calls.push({ slug, sourceId: opts.sourceId, includeDeleted: opts.includeDeleted });
        const sourceKey = opts.sourceId ?? '__cross__';
        const slugs = pagesBySource[sourceKey] ?? [];
        if (slugs.includes(slug)) {
          return { slug, source_id: opts.sourceId ?? 'default', body: 'stub body', deleted_at: null };
        }
        return null;
      },
      resolveSlugs: async () => [],
      getTags: async () => [],
      // remaining engine methods unused for this op; default to throwing.
    },
  };
}

function ctx(sourceId: string | undefined, engineStub: any): OperationContext {
  return {
    engine: engineStub.engine,
    sourceId,
    logger: STUB_LOGGER,
    config: STUB_CONFIG,
  } as unknown as OperationContext;
}

describe('get_page source_id parameter handling', () => {
  const get_page = findOp('get_page');

  test('explicit p.source_id overrides ctx.sourceId', async () => {
    // Page lives in non-default source. Bearer's ctx.sourceId is 'default'.
    // Pre-PR: would fail page_not_found. Post-PR: succeeds.
    const engine = recordingEngine({
      'priv-karriere-entities': ['claim/15-end-to-end-produkt-ownership'],
    });
    const result = await get_page.handler(
      ctx('default', engine),
      { slug: 'claim/15-end-to-end-produkt-ownership', source_id: 'priv-karriere-entities' }
    );
    expect(result).toBeTruthy();
    expect(engine.calls[0].sourceId).toBe('priv-karriere-entities');
  });

  test('without p.source_id falls back to ctx.sourceId (backwards compat)', async () => {
    const engine = recordingEngine({
      'default': ['some-page'],
    });
    const result = await get_page.handler(
      ctx('default', engine),
      { slug: 'some-page' }
    );
    expect(result).toBeTruthy();
    expect(engine.calls[0].sourceId).toBe('default');
  });

  test('with neither p.source_id nor ctx.sourceId, sourceOpts is empty (cross-source view)', async () => {
    const engine = recordingEngine({
      '__cross__': ['some-page'],
    });
    const result = await get_page.handler(
      ctx(undefined, engine),
      { slug: 'some-page' }
    );
    expect(result).toBeTruthy();
    expect(engine.calls[0].sourceId).toBeUndefined();
  });

  test('fuzzy resolution honors explicit source_id', async () => {
    // When fuzzy is used, both the initial getPage and the fuzzy
    // getPage(candidate) must use the same effective source.
    const engine = {
      calls: [] as Array<{ slug: string; sourceId?: string }>,
      engine: {
        getPage: async function (this: any, slug: string, opts: { sourceId?: string }) {
          this.calls.push({ slug, sourceId: opts.sourceId });
          if (slug === 'fuzzy-target-resolved') {
            return { slug, source_id: opts.sourceId ?? 'default', body: 'stub', deleted_at: null };
          }
          return null;
        },
        resolveSlugs: async (_slug: string) => ['fuzzy-target-resolved'],
        getTags: async () => [],
      },
    } as any;
    engine.engine.getPage = engine.engine.getPage.bind(engine);
    const result = await get_page.handler(
      ctx('default', engine),
      { slug: 'fuzzy-target', fuzzy: true, source_id: 'priv-karriere-entities' }
    );
    expect(result).toBeTruthy();
    // Both lookups (initial + fuzzy-resolved) must use the override.
    expect(engine.calls.every((c: { sourceId?: string }) => c.sourceId === 'priv-karriere-entities')).toBe(true);
    expect(engine.calls.length).toBe(2);
  });

  test('source_id is declared in params schema', () => {
    const p = get_page.params.source_id;
    expect(p).toBeDefined();
    expect(p.type).toBe('string');
    // Description should mention the override behavior so MCP clients
    // discover the capability.
    expect(p.description?.toLowerCase() ?? '').toContain('override');
  });
});
