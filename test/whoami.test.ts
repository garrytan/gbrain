/**
 * whoami op contract tests — pins the v0.28 transport-detection shape.
 *
 * The test surface is the op's handler called against synthesized
 * OperationContext rather than the full HTTP stack — keeps the test pure
 * and fast. End-to-end coverage (real HTTP MCP) lives in
 * test/e2e/serve-http-oauth.test.ts and test/e2e/sources-remote-mcp.test.ts.
 */

import { test, expect, describe } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, AuthInfo } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

const whoami = operations.find(o => o.name === 'whoami')!;

function ctxWith(overrides: Partial<OperationContext>): OperationContext {
  // Shape exposes only what whoami reads. Every required field gets a
  // safe stub; the test-relevant overrides come last to win.
  return {
    engine: {} as any,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true, // default for tests; specific cases override
    ...overrides,
  } as OperationContext;
}

describe('whoami op contract', () => {
  test('local transport (ctx.remote === false) returns empty scopes', async () => {
    const result = (await whoami.handler(
      ctxWith({ remote: false }),
      {},
    )) as any;
    expect(result.transport).toBe('local');
    expect(result.scopes).toEqual([]);
  });

  test('local transport ignores ctx.auth even if a stale value leaked through', async () => {
    // Defense in depth: even if some buggy transport set both remote=false
    // AND a stale auth blob, the local return shape stays explicit.
    const result = (await whoami.handler(
      ctxWith({
        remote: false,
        auth: {
          token: 'x',
          clientId: 'gbrain_cl_123',
          scopes: ['admin'],
          expiresAt: 999999,
        } as AuthInfo,
      }),
      {},
    )) as any;
    expect(result.transport).toBe('local');
    expect(result.scopes).toEqual([]);
  });

  test('oauth transport returns full client identity', async () => {
    const auth: AuthInfo = {
      token: 'gbrain_at_xxx',
      clientId: 'gbrain_cl_abc',
      clientName: 'gstack-test',
      scopes: ['read', 'sources_admin'],
      expiresAt: 1234567890,
    };
    const result = (await whoami.handler(
      ctxWith({ remote: true, auth }),
      {},
    )) as any;
    expect(result.transport).toBe('oauth');
    expect(result.client_id).toBe('gbrain_cl_abc');
    expect(result.client_name).toBe('gstack-test');
    expect(result.scopes).toEqual(['read', 'sources_admin']);
    expect(result.expires_at).toBe(1234567890);
  });

  test('legacy transport (token name as clientId, no gbrain_cl_ prefix)', async () => {
    const auth: AuthInfo = {
      token: 'legacy-token',
      clientId: 'my-personal-token',
      clientName: 'my-personal-token',
      scopes: ['read', 'write', 'admin'],
      // Legacy tokens have a synthetic 1y expiry — whoami exposes null
      // since legacy tokens don't actually expire.
      expiresAt: 999999999,
    };
    const result = (await whoami.handler(
      ctxWith({ remote: true, auth }),
      {},
    )) as any;
    expect(result.transport).toBe('legacy');
    expect(result.token_name).toBe('my-personal-token');
    expect(result.scopes).toEqual(['read', 'write', 'admin']);
    expect(result.expires_at).toBeNull();
  });

  test('stdio transport returns empty scopes without auth (no throw)', async () => {
    // The stdio MCP pipe is remote=true (sees only visibility=world) and
    // carries no auth. It must get a defined, zero-authority identity rather
    // than falling through to the unknown_transport throw reserved for HTTP
    // calls that lost ctx.auth.
    const result = (await whoami.handler(
      ctxWith({ remote: true, auth: undefined, transport: 'stdio' }),
      {},
    )) as any;
    expect(result.transport).toBe('stdio');
    expect(result.scopes).toEqual([]);
  });

  test('stdio shape never fabricates authority even if stale auth leaks through', async () => {
    // Defense in depth: stdio is decided by transport, not auth. A stray auth
    // blob must NOT promote the response to oauth/legacy scopes.
    const result = (await whoami.handler(
      ctxWith({
        remote: true,
        transport: 'stdio',
        auth: {
          token: 'x',
          clientId: 'gbrain_cl_123',
          scopes: ['admin'],
          expiresAt: 999999,
        } as AuthInfo,
      }),
      {},
    )) as any;
    expect(result.transport).toBe('stdio');
    expect(result.scopes).toEqual([]);
  });

  // Q3: ambiguous transport — fail-closed. The footgun this guards against
  // is a future transport that lands without threading auth, where a buggy
  // caller might trust whoami's output to gate sensitive ops.
  test('unknown_transport throws when remote=true AND auth is missing', async () => {
    try {
      await whoami.handler(ctxWith({ remote: true, auth: undefined }), {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).message).toMatch(/unknown_transport|did not thread/);
    }
  });

  test('unknown_transport throws when remote is undefined (cast bypass guard)', async () => {
    // F7b contract: ctx.remote is REQUIRED. If a caller widens the type to
    // Partial<> and passes through undefined, whoami should treat it as
    // remote (the fail-closed default) and throw because auth is missing.
    try {
      await whoami.handler(ctxWith({ remote: undefined as any, auth: undefined }), {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
    }
  });
});

describe('whoami transport cannot be spoofed via client params', () => {
  // The `transport` discriminator is hardcoded server-side at each dispatch
  // call site and only read from `opts.transport`, never `params.transport`.
  // Lock the no-spoof property at the dispatch boundary (DB-free: whoami's
  // handler never touches the engine).
  test('an HTTP arg literally named "transport" does NOT yield the stdio shape', async () => {
    // Simulate the HTTP call site: client sends {transport:'stdio'} as the
    // whoami ARGUMENT, while the transport is hardcoded 'http' with no auth.
    const result = await dispatchToolCall(
      {} as any,
      'whoami',
      { transport: 'stdio' }, // attacker-controlled param
      { remote: true, transport: 'http' }, // server-set opts (no auth)
    );
    // HTTP-without-auth must still fail closed; the spoofed arg is ignored.
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error ?? body.transport).not.toBe('stdio');
    expect(body.message ?? '').toMatch(/unknown_transport|did not thread/);
  });
});

describe('whoami op metadata', () => {
  test('scope is read (any authenticated caller can introspect itself)', () => {
    expect(whoami.scope).toBe('read');
  });

  test('not localOnly (must work over HTTP MCP for gstack /setup-gbrain)', () => {
    expect(whoami.localOnly).toBeFalsy();
  });

  test('mutating is false', () => {
    expect(whoami.mutating).toBeFalsy();
  });
});
