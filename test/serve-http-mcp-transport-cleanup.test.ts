/**
 * #2844: POST /mcp per-request transport/server cleanup pin.
 *
 * serve --http creates a fresh Server + StreamableHTTPServerTransport per
 * POST /mcp request (SDK stateless pattern). Without an explicit cleanup
 * hook, neither is ever closed — each request leaks the transport's
 * response bookkeeping plus the Server's handler closures (observed as
 * ~3GB/day RSS growth on a busy remote brain).
 *
 * The SDK's documented stateless recipe is:
 *
 *   const transport = new StreamableHTTPServerTransport({ ... });
 *   res.on('close', () => { transport.close(); server.close(); });
 *   await server.connect(transport);
 *   await transport.handleRequest(req, res, req.body);
 *
 * This source-text pin asserts the res.on('close') cleanup sits BETWEEN
 * transport construction and transport.handleRequest — registered before
 * any request handling can start, so an early client disconnect (or a
 * throw inside handleRequest) still tears both objects down.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('POST /mcp transport cleanup (#2844)', () => {
  const src = readFileSync('src/commands/serve-http.ts', 'utf8');

  test('res.on(close) cleanup sits between transport construction and handleRequest', () => {
    const constructIdx = src.indexOf('new StreamableHTTPServerTransport(');
    expect(constructIdx).toBeGreaterThan(-1);
    // Exactly one per-request construction site — a second one would need
    // its own cleanup wiring and this pin extended to cover it.
    expect(src.indexOf('new StreamableHTTPServerTransport(', constructIdx + 1)).toBe(-1);

    const handleIdx = src.indexOf('transport.handleRequest(', constructIdx);
    expect(handleIdx).toBeGreaterThan(constructIdx);

    const between = src.slice(constructIdx, handleIdx);

    // Cleanup must be registered on the response's close event...
    expect(between).toContain("res.on('close'");
    // ...and must close BOTH per-request objects, swallowing rejections
    // (cleanup is best-effort; it must never surface an unhandledRejection).
    expect(between).toMatch(/transport\.close\(\)\.catch\(/);
    expect(between).toMatch(/server\.close\(\)\.catch\(/);
  });

  test('cleanup registers before server.connect (early-disconnect safety)', () => {
    const constructIdx = src.indexOf('new StreamableHTTPServerTransport(');
    const connectIdx = src.indexOf('server.connect(transport)', constructIdx);
    expect(connectIdx).toBeGreaterThan(constructIdx);

    const beforeConnect = src.slice(constructIdx, connectIdx);
    expect(beforeConnect).toContain("res.on('close'");
  });
});
