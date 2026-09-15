import { describe, expect, test } from 'bun:test';
import type { RequestHandler } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { withBearerScopeHint } from '../src/commands/serve-http-oauth.ts';

describe('withBearerScopeHint', () => {
  test('adds least-privilege scopes to an SDK bearer challenge without enforcing them', async () => {
    const headers = new Map<string, string>();
    const response = {
      set(field: string, value: string) {
        headers.set(field.toLowerCase(), value);
        return response;
      },
    } as any;
    let nextCalled = false;
    const sdkMiddleware = ((_req, res, _next) => {
      res.set(
        'WWW-Authenticate',
        'Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="https://example.test/.well-known/oauth-protected-resource/mcp"',
      );
    }) as RequestHandler;

    await withBearerScopeHint(sdkMiddleware, ['read', 'write'])(
      {} as any,
      response,
      () => { nextCalled = true; },
    );

    expect(headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="https://example.test/.well-known/oauth-protected-resource/mcp", scope="read write"',
    );
    expect(nextCalled).toBe(false);
  });

  test('preserves Express object-form res.set calls', async () => {
    const calls: unknown[][] = [];
    const response = {
      set(...args: unknown[]) {
        calls.push(args);
        return response;
      },
    } as any;
    const sdkMiddleware = ((_req, res, _next) => {
      res.set({ 'Cache-Control': 'no-store' });
    }) as RequestHandler;

    await withBearerScopeHint(sdkMiddleware, ['read', 'write'])(
      {} as any,
      response,
      () => {},
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual({ 'Cache-Control': 'no-store' });
  });

  test('does not duplicate a scope already emitted by the wrapped middleware', async () => {
    const headers = new Map<string, string>();
    const response = {
      set(field: string, value: string) {
        headers.set(field.toLowerCase(), value);
        return response;
      },
    } as any;
    const sdkMiddleware = ((_req, res, _next) => {
      res.set('WWW-Authenticate', 'Bearer error="invalid_token", scope="read"');
    }) as RequestHandler;

    await withBearerScopeHint(sdkMiddleware, ['read', 'write'])({} as any, response, () => {});

    expect(headers.get('www-authenticate')).toBe('Bearer error="invalid_token", scope="read"');
  });

  test.each(['agent', 'admin'])('does not enforce the hint against a valid %s token', async grantedScope => {
    let nextCalled = false;
    const middleware = withBearerScopeHint(requireBearerAuth({
      verifier: {
        async verifyAccessToken(token: string) {
          return {
            token,
            clientId: 'scope-hint-test',
            scopes: [grantedScope],
            expiresAt: Math.floor(Date.now() / 1000) + 60,
          };
        },
      },
      resourceMetadataUrl: 'https://example.test/.well-known/oauth-protected-resource/mcp',
    }), ['read', 'write']);

    await middleware(
      { headers: { authorization: 'Bearer valid-token' } } as any,
      {} as any,
      () => { nextCalled = true; },
    );

    expect(nextCalled).toBe(true);
  });
});
