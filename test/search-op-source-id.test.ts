/**
 * #4398 — the `search` op must accept `source_id` like `query` does.
 *
 * MCP clients passed `source_id` to `search`, got a "unknown parameter
 * ignored" warning, and silently read UNSCOPED results — while the sibling
 * `query` op honored the same parameter via federatedSearchScope /
 * resolveRequestedScope. Pins:
 *
 *   1. the param exists on the op contract (no more unknown-param warning);
 *   2. an explicit source_id scopes results to that source (both trust
 *      classes), on the hybrid path AND the keyword-only opt-out path;
 *   3. a remote caller with a federated grant gets permission_denied for an
 *      out-of-grant source_id (the single-resolver posture);
 *   4. '__all__' spans the brain for trusted local callers.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

const search = operations.find((o) => o.name === 'search')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as unknown as OperationContext['engine'],
    config: {} as OperationContext['config'],
    logger: console as unknown as OperationContext['logger'],
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}

async function slugsFor(ctx: OperationContext, params: Record<string, unknown>): Promise<string[]> {
  const results = (await search.handler(ctx, { query: 'zephyrblatt', ...params })) as Array<{ slug: string }>;
  return results.map((r) => r.slug);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('wiki', 'Wiki') ON CONFLICT (id) DO NOTHING`,
  );
  // The same distinctive token in both sources so scoping is observable.
  // putPage alone leaves content_chunks empty (chunking is the import/embed
  // lane's job), so seed chunks too — the keyword FTS arm reads them.
  for (const [slug, sourceId] of [
    ['notes/zeph-default', 'default'],
    ['notes/zeph-wiki', 'wiki'],
  ] as const) {
    await engine.putPage(slug, {
      type: 'note', title: `Zephyrblatt ${sourceId}`, compiled_truth: `the zephyrblatt lives in ${sourceId}`,
    }, { sourceId });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: `the zephyrblatt lives in ${sourceId}`, chunk_source: 'compiled_truth' },
    ], { sourceId });
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('search op — source_id param (#4398)', () => {
  test('the op contract carries source_id (parity with query)', () => {
    expect(search.params.source_id).toBeDefined();
    const query = operations.find((o) => o.name === 'query')!;
    expect(query.params.source_id).toBeDefined();
  });

  test('explicit source_id scopes the hybrid path to that source', async () => {
    const slugs = await slugsFor(ctxOf(), { source_id: 'wiki' });
    expect(slugs).toContain('notes/zeph-wiki');
    expect(slugs).not.toContain('notes/zeph-default');
  });

  test("'__all__' spans every source for trusted local callers", async () => {
    const slugs = await slugsFor(ctxOf(), { source_id: '__all__' });
    expect(slugs).toContain('notes/zeph-wiki');
    expect(slugs).toContain('notes/zeph-default');
  });

  test('remote caller with a federated grant: out-of-grant source_id is permission_denied', async () => {
    const ctx = ctxOf({
      remote: true,
      auth: {
        token: 'gbrain_at_test',
        clientId: 'gbrain_cl_test',
        scopes: ['read'],
        allowedSources: ['default'],
      } as OperationContext['auth'],
    });
    await expect(slugsFor(ctx, { source_id: 'wiki' })).rejects.toThrow(OperationError);
  });

  test('keyword-only opt-out path honors source_id too', async () => {
    await engine.setConfig('search.mcp_keyword_only', 'true');
    try {
      const slugs = await slugsFor(ctxOf(), { source_id: 'wiki' });
      expect(slugs).toContain('notes/zeph-wiki');
      expect(slugs).not.toContain('notes/zeph-default');
    } finally {
      await engine.setConfig('search.mcp_keyword_only', 'false');
    }
  });
});
