/**
 * Large pages (Wave A): the dispatcher's egress backstop. A read whose final
 * encoded JSON-RPC frame is over the connection's cap is replaced by a
 * structured result_too_large, never cut; writes are never replaced; the
 * trusted local CLI has no cap. Hermetic in-memory PGLite.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall, buildOperationContext } from '../src/mcp/dispatch.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { EGRESS_CAP_DEFAULTS, EGRESS_CAP_MAX, EGRESS_CAP_MIN, encodedFrameBytes, frameOverCap, resultByteCap } from '../src/core/egress-budget.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const body = Array.from({ length: 5000 }, (_, i) => `line ${i} "quoted" text about acme-example widgets\twith a tab`).join('\n');
  const r = await importFromContent(engine, 'logs/wide', serializeMarkdown({}, body, '', { type: 'note', title: 'wide', tags: [] }),
    { sourceId: 'default', noEmbed: true, forceRechunk: true });
  expect(r.status).toBe('imported');
}, 120_000);

afterAll(async () => { await engine.disconnect(); }, 60_000);

describe('caps', () => {
  test('defaults, clamping and the local CLI', async () => {
    expect(await resultByteCap({ remote: true, transport: 'stdio' })).toBe(EGRESS_CAP_DEFAULTS.stdio);
    expect(await resultByteCap({ remote: true, transport: 'http' })).toBe(EGRESS_CAP_DEFAULTS.http);
    expect(await resultByteCap({ remote: true })).toBe(EGRESS_CAP_DEFAULTS.http);
    expect(await resultByteCap({ remote: false, transport: 'stdio' })).toBe(Number.POSITIVE_INFINITY);
    expect(await resultByteCap({ remote: true, transport: 'http', config: { mcp: { max_result_bytes_http: 1 } } as any })).toBe(EGRESS_CAP_MIN);
    expect(await resultByteCap({ remote: true, transport: 'stdio', config: { mcp: { max_result_bytes_stdio: 1e12 } } as any })).toBe(EGRESS_CAP_MAX);
  });

  test('the DB plane wins over the file plane', async () => {
    await engine.setConfig('mcp.max_result_bytes_http', String(300 * 1024));
    try {
      expect(await resultByteCap({ remote: true, transport: 'http', engine, config: { mcp: { max_result_bytes_http: 2_000_000 } } as any })).toBe(300 * 1024);
    } finally {
      await engine.unsetConfig('mcp.max_result_bytes_http');
    }
  });

  test('the frame is measured encoded, escapes included', () => {
    const text = '"\n'.repeat(1000);
    expect(encodedFrameBytes({ content: [{ type: 'text', text: JSON.stringify({ text }) }] })).toBeGreaterThan(text.length * 3);
  });

  test('frameOverCap is null for the local CLI and under the cap', async () => {
    const big = { content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] };
    expect(await frameOverCap(big, { remote: false })).toBeNull();
    expect(await frameOverCap(big, { remote: true, transport: 'stdio' })).toBeNull();
    expect((await frameOverCap(big, { remote: true, transport: 'http' }))?.cap).toBe(EGRESS_CAP_DEFAULTS.http);
  });
});

describe('dispatch backstop', () => {
  test('an oversized read is result_too_large with the measured size, nothing cut', async () => {
    const config = { engine: 'pglite', mcp: { max_result_bytes_stdio: EGRESS_CAP_MIN } } as any;
    const out = await dispatchToolCall(engine, 'get_chunks', { slug: 'logs/wide', limit: 500 }, { remote: true, transport: 'stdio', sourceId: 'default', config });
    expect(out.isError).toBe(true);
    const env = JSON.parse(out.content[0].text);
    expect(env.code ?? env.error).toBe('result_too_large');
    const detail = typeof env.detail === 'string' ? JSON.parse(env.detail) : env.detail;
    expect(detail.max_result_bytes).toBe(EGRESS_CAP_MIN);
    expect(detail.result_bytes).toBeGreaterThan(EGRESS_CAP_MIN);
    expect(out.content.map(c => c.text).join('')).not.toContain('line 4999');
  });

  test('the same read under the cap passes untouched', async () => {
    const out = await dispatchToolCall(engine, 'get_chunks', { slug: 'logs/wide' }, { remote: true, transport: 'stdio', sourceId: 'default', config: { engine: 'pglite' } as any });
    expect(out.isError).toBeFalsy();
    expect(encodedFrameBytes(out)).toBeLessThanOrEqual(EGRESS_CAP_DEFAULTS.stdio);
  });

  test('the thin-client marker reaches the operation context and nothing else', () => {
    expect(buildOperationContext(engine, {}, { remote: true, transport: 'http', thinClient: true }).thinClient).toBe(true);
    expect(buildOperationContext(engine, {}, { remote: true, transport: 'http' }).thinClient).toBeUndefined();
  });
});
