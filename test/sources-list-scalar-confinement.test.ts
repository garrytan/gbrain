/**
 * #4433 wave-L — sources_list confines remote scalar/no-grant callers too.
 *
 * Wave-g row-filtered the listing only for callers WITH a federated grant
 * and deliberately left the scalar default-source floor unfiltered ("that
 * caller may read any source by naming it"). The maintainer has since
 * adopted the stricter posture: EVERY untrusted caller (anything not
 * strictly `ctx.remote === false`) is confined through the canonical
 * sourceScopeOpts ladder, matching the rest of the read-op surface —
 * federated grant > scalar bound source > fail-closed `__all__`. A scalar
 * caller's listing now shows exactly its resolved scope; enumerating the
 * rest of the registry (id, name, page_count) requires naming a source,
 * which is an audit-visible act rather than a bulk disclosure.
 *
 * The trusted local CLI (`ctx.remote === false`) keeps the full operator
 * listing — sources management is its surface.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

const op = operations.find((o) => o.name === 'sources_list')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as unknown as OperationContext['engine'],
    config: {} as OperationContext['config'],
    logger: console as unknown as OperationContext['logger'],
    dryRun: false,
    remote: true,
    ...overrides,
  } as OperationContext;
}

function authOf(allowedSources?: string[]): OperationContext['auth'] {
  return {
    token: 'gbrain_at_test',
    clientId: 'gbrain_cl_test',
    clientName: 'token-b',
    scopes: ['read'],
    ...(allowedSources ? { allowedSources } : {}),
  } as OperationContext['auth'];
}

async function listedIds(
  ctx: OperationContext,
  params: Record<string, unknown> = {},
): Promise<string[]> {
  const res = (await op.handler(ctx, params)) as { sources: Array<{ id: string }> };
  return res.sources.map((s) => s.id);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('wiki', 'Wiki'), ('restricted', 'Restricted')
     ON CONFLICT (id) DO NOTHING`,
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('sources_list — scalar/no-grant remote confinement (#4433 wave-L)', () => {
  test('remote scalar default-source floor sees ONLY its resolved source', async () => {
    const ids = await listedIds(ctxOf({ remote: true, sourceId: 'default', auth: authOf() }));
    expect(ids).toEqual(['default']);
  });

  test('remote scalar caller bound to a non-default source sees only that source', async () => {
    const ids = await listedIds(ctxOf({ remote: true, sourceId: 'wiki', auth: authOf() }));
    expect(ids).toEqual(['wiki']);
  });

  test('empty allowedSources falls to the scalar floor, never widens to all', async () => {
    const ids = await listedIds(ctxOf({ remote: true, sourceId: 'default', auth: authOf([]) }));
    expect(ids).toEqual(['default']);
  });

  test('legacy bearer shape (no auth object, transport sourceId) is confined too', async () => {
    const ids = await listedIds(ctxOf({ remote: true, sourceId: 'default' }));
    expect(ids).toEqual(['default']);
  });

  test("remote '__all__' sentinel fail-closes to an empty listing", async () => {
    // '__all__' can never match a real source id (underscores are rejected
    // at creation), so the ladder's literal pass-through yields zero rows
    // rather than widening past the caller's scope.
    const ids = await listedIds(ctxOf({ remote: true, sourceId: '__all__' }));
    expect(ids).toEqual([]);
  });

  test('scalar confinement composes with include_archived (no resurrection outside scope)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES
         ('wiki-archived', 'WA', true), ('restricted-archived', 'RA', true)
       ON CONFLICT (id) DO NOTHING`,
    );
    const ctx = ctxOf({ remote: true, sourceId: 'wiki-archived', auth: authOf() });
    expect(await listedIds(ctx)).toEqual([]);
    expect(await listedIds(ctx, { include_archived: true })).toEqual(['wiki-archived']);
  });

  test("trusted local CLI keeps the full operator listing (even via '__all__')", async () => {
    const ids = await listedIds(ctxOf({ remote: false, sourceId: '__all__' }));
    expect(ids).toContain('default');
    expect(ids).toContain('wiki');
    expect(ids).toContain('restricted');
  });
});
