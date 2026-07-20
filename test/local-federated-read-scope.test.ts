/**
 * Local federated read fan-out — unit layer.
 *
 * Covers the two pure-ish pieces of the feature:
 *   1. `sourceScopeOpts` precedence with the new `ctx.sourceIds` field
 *      (auth grant > local federated array > scalar > {}), including the
 *      `!ctx.auth` gate that keeps authenticated grants authoritative.
 *   2. `resolveLocalFederatedReadScope` against a hand-rolled fake engine
 *      (only `executeRaw` is exercised by fetchSource/loadAllSources), so
 *      the unit layer stays PGLite-free. Engine-integration behavior is
 *      pinned by test/e2e/local-federated-scope-pglite.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import {
  sourceScopeOpts,
  thinkSourceScopeOpts,
  linkReadScopeOpts,
  resolveCodeIntelScope,
  type OperationContext,
} from '../src/core/operations.ts';
import { resolveLocalFederatedReadScope } from '../src/core/sources-load.ts';
import { buildOperationContext } from '../src/mcp/dispatch.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function ctxWith(partial: Partial<OperationContext>): OperationContext {
  return {
    engine: {} as BrainEngine,
    config: { engine: 'pglite' } as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: 'active',
    ...partial,
  } as OperationContext;
}

describe('sourceScopeOpts — local federated read scope precedence', () => {
  test('auth.allowedSources wins over ctx.sourceIds', () => {
    const ctx = ctxWith({
      auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['a', 'b'] } as OperationContext['auth'],
      sourceIds: ['x', 'y', 'z'],
    });
    expect(sourceScopeOpts(ctx)).toEqual({ sourceIds: ['a', 'b'] });
  });

  test('ctx.sourceIds is IGNORED for any authenticated caller (legacy token, no allowedSources)', () => {
    const ctx = ctxWith({
      auth: { token: 't', clientId: 'c', scopes: ['read'] } as OperationContext['auth'],
      sourceIds: ['x', 'y'],
      sourceId: 'active',
    });
    // Authed caller with no federated grant → scalar, never the local array.
    expect(sourceScopeOpts(ctx)).toEqual({ sourceId: 'active' });
  });

  test('unauthenticated caller with ctx.sourceIds gets the federated array', () => {
    const ctx = ctxWith({ sourceIds: ['a', 'b', 'active'] });
    expect(sourceScopeOpts(ctx)).toEqual({ sourceIds: ['a', 'b', 'active'] });
  });

  test('empty ctx.sourceIds never widens — falls through to scalar', () => {
    const ctx = ctxWith({ sourceIds: [] });
    expect(sourceScopeOpts(ctx)).toEqual({ sourceId: 'active' });
  });

  test('no sourceIds → scalar; no scalar → {}', () => {
    expect(sourceScopeOpts(ctxWith({}))).toEqual({ sourceId: 'active' });
    expect(sourceScopeOpts(ctxWith({ sourceId: undefined as unknown as string }))).toEqual({});
  });
});

// ── Fake engine: routes fetchSource (WHERE id = $1) and loadAllSources ──

interface FakeRow {
  id: string;
  name: string;
  local_path: string | null;
  last_commit: string | null;
  last_sync_at: Date | null;
  config: unknown;
  created_at: Date;
  archived?: boolean;
}

function fakeEngine(rows: FakeRow[], opts: { throwAlways?: boolean } = {}): BrainEngine {
  return {
    executeRaw: async (sql: string, params?: unknown[]) => {
      if (opts.throwAlways) throw new Error('relation "sources" does not exist');
      if (/WHERE id = \$1/.test(sql)) {
        return rows.filter((r) => r.id === (params?.[0] as string));
      }
      return rows;
    },
  } as unknown as BrainEngine;
}

function row(id: string, config: unknown, archived = false): FakeRow {
  return {
    id,
    name: id,
    local_path: null,
    last_commit: null,
    last_sync_at: null,
    config,
    created_at: new Date('2026-01-01'),
    archived,
  };
}

describe('resolveLocalFederatedReadScope', () => {
  test('active federated + peers → returns the federated union including active', async () => {
    const engine = fakeEngine([
      row('active', { federated: true }),
      row('peer', { federated: true }),
      row('iso', { federated: false }),
    ]);
    const ids = await resolveLocalFederatedReadScope(engine, 'active');
    expect(ids?.sort()).toEqual(['active', 'peer']);
  });

  test('double-encoded JSONB config (string) is still recognized as federated', async () => {
    const engine = fakeEngine([
      row('active', '{"federated":true}'),
      row('peer', '{"federated":true}'),
    ]);
    const ids = await resolveLocalFederatedReadScope(engine, 'active');
    expect(ids?.sort()).toEqual(['active', 'peer']);
  });

  test('active isolated → undefined (scalar pin preserved)', async () => {
    const engine = fakeEngine([
      row('active', { federated: false }),
      row('peer', { federated: true }),
      row('peer2', { federated: true }),
    ]);
    expect(await resolveLocalFederatedReadScope(engine, 'active')).toBeUndefined();
  });

  test('active source missing → undefined', async () => {
    const engine = fakeEngine([row('peer', { federated: true })]);
    expect(await resolveLocalFederatedReadScope(engine, 'ghost')).toBeUndefined();
  });

  test('active archived → undefined even when federated', async () => {
    const engine = fakeEngine([
      row('active', { federated: true }, true),
      row('peer', { federated: true }),
    ]);
    expect(await resolveLocalFederatedReadScope(engine, 'active')).toBeUndefined();
  });

  test('archived federated peers are excluded from the union', async () => {
    const engine = fakeEngine([
      row('active', { federated: true }),
      row('peer', { federated: true }),
      row('old', { federated: true }, true),
    ]);
    const ids = await resolveLocalFederatedReadScope(engine, 'active');
    expect(ids?.sort()).toEqual(['active', 'peer']);
  });

  test('single federated source (fan-out is a no-op) → undefined', async () => {
    const engine = fakeEngine([
      row('active', { federated: true }),
      row('iso', { federated: false }),
    ]);
    expect(await resolveLocalFederatedReadScope(engine, 'active')).toBeUndefined();
  });

  test('engine error (pre-init brain, missing table) → undefined, never throws', async () => {
    const engine = fakeEngine([], { throwAlways: true });
    expect(await resolveLocalFederatedReadScope(engine, 'active')).toBeUndefined();
  });

  test('engine error fires opts.onError so long-lived callers can log it', async () => {
    const engine = fakeEngine([], { throwAlways: true });
    let seen: unknown = null;
    await resolveLocalFederatedReadScope(engine, 'active', { onError: (e) => { seen = e; } });
    expect(seen).toBeInstanceOf(Error);
  });
});

describe('scope policy under the local federated array', () => {
  test('linkReadScopeOpts: trusted local CLI keeps the scalar cross-source link view', () => {
    // The engine's scalar branch scopes only the near endpoint by design —
    // fanning the local array through the all-endpoint branch would hide
    // links whose far endpoint lives in an isolated source.
    const ctx = ctxWith({ remote: false, sourceId: 'active', sourceIds: ['active', 'peer'] });
    expect(linkReadScopeOpts(ctx)).toEqual({ sourceId: 'active' });
  });

  test('linkReadScopeOpts: unauthenticated stdio (remote) with the local array keeps all-endpoint scoping', () => {
    const ctx = ctxWith({ remote: true, sourceId: 'active', sourceIds: ['active', 'peer'] });
    expect(linkReadScopeOpts(ctx)).toEqual({ sourceIds: ['active', 'peer'] });
  });

  test('thinkSourceScopeOpts: local array emits BOTH allowedSources and the active scalar', () => {
    // runThink anchors trajectory entity-resolution and persistence on
    // opts.sourceId; dropping it would degrade those to 'default'.
    const ctx = ctxWith({ sourceIds: ['active', 'peer'], sourceId: 'active' });
    expect(thinkSourceScopeOpts(ctx)).toEqual({ allowedSources: ['active', 'peer'], sourceId: 'active' });
  });

  test('thinkSourceScopeOpts: authenticated grant stays array-only (semantics unchanged)', () => {
    const ctx = ctxWith({
      sourceId: 'active',
      auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['a', 'b'] } as OperationContext['auth'],
    });
    expect(thinkSourceScopeOpts(ctx)).toEqual({ allowedSources: ['a', 'b'] });
  });

  test('resolveCodeIntelScope: local unauthenticated multi-element scope collapses to the ACTIVE scalar', () => {
    const ctx = ctxWith({ remote: true, sourceId: 'active', sourceIds: ['active', 'peer'] });
    expect(resolveCodeIntelScope(ctx, undefined)).toEqual({ allSources: false, sourceId: 'active' });
  });

  test('buildOperationContext threads DispatchOpts.sourceIds into the ctx', () => {
    const ctx = buildOperationContext({} as BrainEngine, {}, {
      remote: true,
      sourceId: 'active',
      sourceIds: ['active', 'peer'],
    });
    expect(ctx.sourceIds).toEqual(['active', 'peer']);
    expect(ctx.sourceId).toBe('active');
  });
});
