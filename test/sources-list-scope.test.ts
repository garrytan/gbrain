/**
 * #4433 — sources_list must honor the caller's federated source grant.
 *
 * The handler dropped ctx on the floor and listSources had no scope param,
 * so every OAuth client — including one whose grant deliberately excludes a
 * source — received the full source table (id, name, page_count of the
 * excluded source). Same class as the #3242 wave that scoped
 * get_page/search/list_pages/resolve_slugs, with existence-of-a-source as
 * the leak instead of pages.
 *
 * Wave-L (maintainer posture decision, supersedes the wave-g rationale that
 * scalar callers keep the full listing "because they can read any source by
 * naming it"): EVERY untrusted caller — anything not strictly
 * `ctx.remote === false` — is confined through the canonical sourceScopeOpts
 * ladder, matching the rest of the read-op surface. Pins (row-filter, not
 * field redaction):
 *
 *   1. trusted local CLI stays UNSCOPED (sources management surface);
 *   2. a remote federated grant sees only its granted rows;
 *   3. a remote scalar default-source floor (no allowedSources) sees only
 *      its resolved source — enumeration now requires naming a source;
 *   4. an empty allowedSources array falls to the scalar floor (same as
 *      sourceScopeOpts' `allowed.length > 0` gate), never to "all".
 *
 * The deeper scalar/no-grant/`__all__` matrix lives in
 * test/sources-list-scalar-confinement.test.ts.
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

async function listedIds(ctx: OperationContext): Promise<string[]> {
  const res = (await op.handler(ctx, {})) as { sources: Array<{ id: string }> };
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

describe('sources_list — caller source grant (#4433)', () => {
  test('trusted local CLI stays unscoped (sees every source)', async () => {
    const ids = await listedIds(ctxOf({ remote: false, sourceId: 'default' }));
    expect(ids).toContain('default');
    expect(ids).toContain('wiki');
    expect(ids).toContain('restricted');
  });

  test('remote federated grant is row-filtered (excluded source invisible)', async () => {
    const ids = await listedIds(ctxOf({
      remote: true,
      sourceId: 'default',
      auth: authOf(['default', 'wiki']),
    }));
    expect(ids.sort()).toEqual(['default', 'wiki']);
    expect(ids).not.toContain('restricted');
  });

  test('include_archived stays inside the grant too', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('archived-restricted', 'AR', true)
       ON CONFLICT (id) DO NOTHING`,
    );
    const res = (await op.handler(
      ctxOf({ remote: true, sourceId: 'default', auth: authOf(['default', 'wiki']) }),
      { include_archived: true },
    )) as { sources: Array<{ id: string }> };
    const ids = res.sources.map((s) => s.id);
    expect(ids).not.toContain('archived-restricted');
    expect(ids).not.toContain('restricted');
  });

  test('remote scalar default-source floor (no grant) is confined to its source', async () => {
    // Wave-L maintainer posture decision (supersedes the wave-g rationale
    // that this caller keeps the full listing because it can read any source
    // by naming it): scalar/no-grant remote callers are confined to their
    // resolved scope like every other read op — bulk enumeration of the
    // registry is gone; reading another source stays an explicit, named act.
    const ids = await listedIds(ctxOf({ remote: true, sourceId: 'default', auth: authOf() }));
    expect(ids).toEqual(['default']);
    expect(ids).not.toContain('wiki');
    expect(ids).not.toContain('restricted');
  });

  test('empty allowedSources falls to the scalar floor (sourceScopeOpts parity)', async () => {
    // Wave-L: `[]` must not widen to "no filter" — it defers to ctx.sourceId,
    // so the listing is the caller's single resolved source, never the table.
    const ids = await listedIds(ctxOf({
      remote: true,
      sourceId: 'default',
      auth: authOf([]),
    }));
    expect(ids).toEqual(['default']);
    expect(ids).not.toContain('restricted');
  });
});
