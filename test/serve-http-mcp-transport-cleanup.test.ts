/**
 * #2844: POST /mcp per-request server cleanup pin (dual-era v2 form).
 *
 * History: serve --http used to create a fresh Server +
 * StreamableHTTPServerTransport per POST /mcp request (the SDK v1 stateless
 * recipe) and needed an explicit `res.on('close')` hook closing both, or
 * each request leaked the transport's response bookkeeping plus the Server's
 * handler closures (~3GB/day RSS on a busy remote brain). The v1 wiring this
 * file used to pin (`new StreamableHTTPServerTransport(` + `res.on('close'`
 * + `transport.handleRequest(` + `server.connect(transport)`) is gone by
 * design: the dual-era migration serves POST /mcp through
 * `createMcpHandler(factory, { legacy: 'stateless' })`, and SDK v2's
 * stateless connector owns the per-request lifecycle.
 *
 * This source-text pin asserts gbrain's side of that contract stays intact:
 * exactly one `createMcpHandler` mount in `legacy: 'stateless'` mode, whose
 * factory builds a FRESH `Server` per request (never a shared module-level
 * instance), and NO hand-rolled per-request `new StreamableHTTPServerTransport(`
 * that could bypass the connector's teardown. Auth still wraps the mount
 * with `withBearerScopeHint(..., ['read'])`.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('POST /mcp transport cleanup (#2844)', () => {
  const src = readFileSync('src/commands/serve-http.ts', 'utf8');

  test('single stateless createMcpHandler mount; factory builds a fresh Server per request', () => {
    const mountIdx = src.indexOf('createMcpHandler(');
    expect(mountIdx).toBeGreaterThan(-1);
    expect(src.indexOf('createMcpHandler(', mountIdx + 1)).toBe(-1);

    const mount = src.slice(mountIdx, mountIdx + 4000);
    expect(mount).toContain('legacy');
    expect(mount).toContain('stateless');
    expect(mount).toMatch(/new Server\(\s*\{ name: 'gbrain'/);
  });

  test('no hand-rolled per-request StreamableHTTPServerTransport (would bypass connector teardown)', () => {
    expect(src.indexOf('new StreamableHTTPServerTransport(')).toBe(-1);
  });

  test('POST /mcp keeps withBearerScopeHint(..., [read]) around the v2 handler', () => {
    const postIdx = src.indexOf("app.post('/mcp'");
    expect(postIdx).toBeGreaterThan(-1);
    const post = src.slice(postIdx, postIdx + 400);
    expect(post).toContain('withBearerScopeHint');
    expect(post).toContain("['read']");
    expect(post).toContain('toNodeHandler(mcpHandler)');
  });
});
