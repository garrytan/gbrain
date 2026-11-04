import { describe, expect, test } from 'bun:test';
import { authorizeOperationContext, federatedSearchScope, resolveRequestedScope, sourceScopeOpts } from '../src/core/ops/context.ts';
import { finalizeOperation, loadOperation } from '../src/core/operation-load.ts';
import { NO_SOURCES } from '../src/core/source-id.ts';
import type { AuthInfo, Operation, OperationContext } from '../src/core/ops/contract.ts';

function ctxOf(auth?: Partial<AuthInfo>): OperationContext {
  return {
    engine: {} as OperationContext['engine'],
    config: { engine: 'postgres' },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: 'transport-default',
    ...(auth ? { auth: { token: 'synthetic-token', clientId: 'synthetic-client', scopes: ['read', 'write'], ...auth } } : {}),
  };
}

describe('authenticated source authority', () => {
  test('missing write authority offers a write-source grant repair, not a read federation', () => {
    const ctx = ctxOf({ allowedSources: ['alpha'], principal: { kind: 'oauth_client', id: 'synthetic-client' } });
    try {
      authorizeOperationContext(ctx, true);
      throw new Error('expected write refusal');
    } catch (error) {
      expect(error).toMatchObject({ code: 'permission_denied', fix: { argv: [
        'gbrain', 'auth', 'rescope-client', 'synthetic-client', '--source', '<source>',
      ] } });
    }
  });

  test('lazy and eager entrypoints share one finalized authorization boundary', async () => {
    const lazy = (await loadOperation('get_tags'))!;
    const handler = lazy.handler;
    const { operationsByName, authorizeOperationContext: publicHelper } = await import('../src/core/operations.ts');
    expect(operationsByName.get_tags).toBe(lazy);
    expect(lazy.handler).toBe(handler);
    finalizeOperation(lazy);
    expect(lazy.handler).toBe(handler);
    expect(publicHelper).toBe(authorizeOperationContext);
    // No engine methods exist: refusal must happen before any handler DB work.
    for (const op of [lazy, operationsByName.get_tags]) {
      await expect(op.handler(ctxOf({}), { slug: 'synthetic/page' }))
        .rejects.toMatchObject({ code: 'permission_denied' });
    }
  });

  test('read and write clones do not mutate each other or the input authority', () => {
    const ctx = ctxOf({ sourceId: 'writer', allowedSources: ['alpha', 'beta'], boundSlugPrefixes: ['synthetic/'] });
    const read = authorizeOperationContext(ctx, false);
    const write = authorizeOperationContext(read, true);
    expect([read.sourceId, write.sourceId, ctx.sourceId]).toEqual(['alpha', 'writer', 'transport-default']);
    expect(read).not.toBe(write);
    write.auth!.allowedSources!.push('other');
    expect(read.auth?.allowedSources).toEqual(['alpha', 'beta']);
    expect(ctx.auth?.allowedSources).toEqual(['alpha', 'beta']);
    expect(write.auth?.boundSlugPrefixes).toEqual(['synthetic/']);
    expect(authorizeOperationContext(read, false)).toEqual(read);
  });

  test('authless local/stdio and historical no-grant legacy federation keep their behavior', () => {
    const stdio = { ...ctxOf(), transport: 'stdio' as const, localFederatedSourceIds: ['transport-default', 'beta'] };
    expect(federatedSearchScope(stdio)).toEqual({ sourceIds: ['transport-default', 'beta'] });
    const legacy = { ...stdio, auth: ctxOf({ hasSourceGrant: false }).auth };
    expect(federatedSearchScope(legacy)).toEqual({ sourceIds: ['transport-default', 'beta'] });
    expect(federatedSearchScope(legacy, 'beta')).toEqual({ sourceId: 'beta' });
    expect(authorizeOperationContext(legacy, true).sourceId).toBe('transport-default');
    expect(sourceScopeOpts({ ...stdio, remote: false, sourceId: '__all__' })).toEqual({});
    expect(sourceScopeOpts({ ...stdio, sourceId: '__all__' })).toEqual({ sourceId: '__all__' });
  });

  test('explicit no-source grants still refuse all reads and writes', () => {
    for (const ctx of [
      { ...ctxOf(), sourceId: NO_SOURCES },
      ctxOf({ sourceId: NO_SOURCES, allowedSources: ['alpha'] }),
    ]) {
      for (const mutating of [false, true]) {
        expect(() => authorizeOperationContext(ctx, mutating))
          .toThrow(expect.objectContaining({ code: 'permission_denied', detail: 'fence=no_source_grant' }));
      }
    }
  });

  test('sparse grants and a federation mislabeled as legacy cannot authorize a source', () => {
    expect(() => sourceScopeOpts(ctxOf({ allowedSources: Array(1) })))
      .toThrow(expect.objectContaining({ code: 'permission_denied' }));
    expect(() => authorizeOperationContext(ctxOf({ hasSourceGrant: false, allowedSources: ['beta'] }), true))
      .toThrow(expect.objectContaining({ code: 'permission_denied' }));
  });

  test('transport federation cannot widen an authenticated scalar grant', () => {
    const ctx = { ...ctxOf({ sourceId: 'alpha' }), localFederatedSourceIds: ['transport-default', 'beta'] };
    expect(federatedSearchScope(ctx)).toEqual({ sourceId: 'alpha' });
    expect(() => federatedSearchScope(ctx, 'beta')).toThrow(expect.objectContaining({ code: 'permission_denied' }));
    expect(() => resolveRequestedScope(ctx, 'transport-default')).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  });

  test('mutating handlers use the explicit write grant, never the read primary or transport default', async () => {
    let calls = 0;
    const op: Operation = {
      name: 'synthetic_write', description: 'Synthetic context writer', params: {}, mutating: true,
      outputRedaction: 'no_stored_text', handler: async ctx => { calls++; return ctx; },
    };
    finalizeOperation(op);
    const ctx = ctxOf({ sourceId: 'writer', allowedSources: ['beta', 'alpha'] });
    const result = await op.handler(ctx, {}) as OperationContext;
    expect(result.sourceId).toBe('writer');
    expect(result).not.toBe(ctx);
    expect(ctx.sourceId).toBe('transport-default');
    expect(calls).toBe(1);
    await expect(op.handler(ctxOf({ allowedSources: ['beta'] }), {}))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect(calls).toBe(1);
  });

  test('finalized readers receive a fresh context whose primary stays inside the read grant', async () => {
    const op: Operation = {
      name: 'synthetic_read', description: 'Synthetic context reader', params: {},
      outputRedaction: 'no_stored_text', handler: async ctx => ctx,
    };
    finalizeOperation(op);
    for (const [sourceId, allowedSources, expected] of [
      ['alpha', undefined, 'alpha'], ['alpha', ['beta', 'alpha'], 'alpha'],
      ['writer', ['beta', 'alpha'], 'beta'], [undefined, ['beta', 'alpha'], 'beta'],
    ] as const) {
      const ctx = ctxOf({ sourceId, allowedSources: allowedSources ? [...allowedSources] : undefined });
      Object.freeze(ctx.auth?.allowedSources);
      Object.freeze(ctx.auth);
      Object.freeze(ctx);
      const result = await op.handler(ctx, {}) as OperationContext;
      expect(result.sourceId).toBe(expected);
      expect(result).not.toBe(ctx);
      expect(result.auth).not.toBe(ctx.auth);
      if (allowedSources) {
        expect(result.auth?.allowedSources).toEqual(allowedSources);
        expect(result.auth?.allowedSources).not.toBe(ctx.auth?.allowedSources);
      }
      expect(ctx.sourceId).toBe('transport-default');
    }
  });

  test('missing or malformed authenticated grants fail closed instead of using a transport default', () => {
    const grants: Partial<AuthInfo>[] = [
      {}, { allowedSources: [] }, { sourceId: '' }, { sourceId: '__all__' },
      { sourceId: 'bad_source' }, { sourceId: 'alpha', allowedSources: ['beta', '__all__'] },
      { sourceId: 'alpha', allowedSources: ['beta', ''] },
      { sourceId: 'alpha', allowedSources: ['beta', 7] as unknown as string[] },
      { sourceId: 'alpha', allowedSources: 'beta' as unknown as string[] },
    ];
    for (const grant of grants) {
      expect(() => sourceScopeOpts(ctxOf(grant))).toThrow(expect.objectContaining({ code: 'permission_denied' }));
    }
  });

  test('scalar authenticated grant overrides the transport default, including an empty federation', () => {
    for (const allowedSources of [undefined, []]) {
      const ctx = ctxOf({ sourceId: 'alpha', allowedSources });
      expect(sourceScopeOpts(ctx)).toEqual({ sourceId: 'alpha' });
      expect(ctx.sourceId).toBe('transport-default');
    }
  });
});
