import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildMcpIngressGuards, DEFAULT_MCP_BODY_CAP, resolveMcpBodyCap } from '../src/mcp/http-ingress-guards.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';

function responseRecorder() {
  const state: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  return {
    state,
    response: {
      set: (key: string, value: string) => { state.headers[key] = value; },
      status: (status: number) => {
        state.status = status;
        return { json: (body: unknown) => { state.body = body; } };
      },
    },
  };
}

describe('OAuth MCP ingress guards', () => {
  test('12 MiB default is finite and a positive env override wins', () => {
    expect(DEFAULT_MCP_BODY_CAP).toBe(12 * 1024 * 1024);
    expect(resolveMcpBodyCap({})).toBe(DEFAULT_MCP_BODY_CAP);
    expect(resolveMcpBodyCap({ GBRAIN_HTTP_MAX_BODY_BYTES: '2048' })).toBe(2048);
    expect(resolveMcpBodyCap({ GBRAIN_HTTP_MAX_BODY_BYTES: 'invalid' })).toBe(DEFAULT_MCP_BODY_CAP);
  });

  test('known oversized Content-Length is rejected before auth', () => {
    const { preAuth } = buildMcpIngressGuards({ env: { GBRAIN_HTTP_MAX_BODY_BYTES: '16' } });
    const { state, response } = responseRecorder();
    let nextCalled = false;
    preAuth({ ip: '127.0.0.1', socket: {}, get: () => '17' } as any, response as any, () => { nextCalled = true; });
    expect(state.status).toBe(413);
    expect(nextCalled).toBe(false);
  });

  test('post-auth limiter keys on the OAuth client id', () => {
    const one = () => new RateLimiter({ limit: 1, windowMs: 60_000, lruCap: 10 }, () => 0);
    const { postAuth } = buildMcpIngressGuards({ limiters: { ip: one(), token: one() } });
    const request = { auth: { clientId: 'client-a' } } as any;
    let passed = 0;
    postAuth(request, responseRecorder().response as any, () => { passed += 1; });
    const second = responseRecorder();
    postAuth(request, second.response as any, () => { passed += 1; });
    expect(passed).toBe(1);
    expect(second.state.status).toBe(429);
  });

  test('serve-http authenticates and rate-limits the client before bounded JSON parsing', () => {
    const source = readFileSync('src/commands/serve-http.ts', 'utf8');
    const start = source.indexOf("app.post('/mcp'");
    const route = source.slice(start, source.indexOf('const startTime', start));
    expect(route.indexOf('mcpPreAuthGuard')).toBeLessThan(route.indexOf('requireBearerAuth'));
    expect(route.indexOf('requireBearerAuth')).toBeLessThan(route.indexOf('mcpPostAuthGuard'));
    expect(route.indexOf('mcpPostAuthGuard')).toBeLessThan(route.indexOf('parseMcpJson'));
  });

  test('legacy transport authenticates before reading the bounded body', () => {
    const source = readFileSync('src/mcp/http-transport.ts', 'utf8');
    const route = source.slice(source.indexOf('// Header-only auth runs BEFORE'), source.indexOf('// Parse JSON-RPC body.'));
    expect(route.indexOf('validateToken')).toBeLessThan(route.indexOf('readBodyWithCap'));
    expect(route.indexOf('limiters.token.check')).toBeLessThan(route.indexOf('readBodyWithCap'));
  });
});
