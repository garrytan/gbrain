/**
 * GBRA-431: the /mcp rate limits and body cap SECURITY.md documents are enforced by `gbrain serve --http`.
 *
 * 1. Protects: with GBRAIN_HTTP_RATE_LIMIT_IP set, POST /mcp answers 429 with Retry-After once an address spends its
 *    bucket, before any token lookup; with GBRAIN_HTTP_RATE_LIMIT_TOKEN set, an authenticated token is throttled the
 *    same way; GBRAIN_HTTP_MAX_BODY_BYTES caps the request body (413). With none set the server keeps its unlimited
 *    rate and 4 MiB body default.
 * 2. Fails when: a set limit is ignored (the settings only reached the legacy transport, which no command starts), or
 *    an unset one starts throttling.
 * 3. Existing coverage: test/rate-limit.test.ts pins the limiter itself; the legacy transport's tests pin its use there.
 * 4. Real seams: the production serve-http app on a loopback port over a repo-less PGLite brain, real fetch.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { legacyToken, rpc, startServeHttp } from './helpers/live-mcp-servers.ts';
import { withEnv } from './helpers/with-env.ts';

const UNSET = { GBRAIN_HTTP_RATE_LIMIT_IP: undefined, GBRAIN_HTTP_RATE_LIMIT_TOKEN: undefined, GBRAIN_HTTP_MAX_BODY_BYTES: undefined };

describe('serve --http enforces the /mcp limits the operator sets', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); }, 60_000);

  const post = (base: string, body: string, token?: string) => fetch(`${base}/mcp`, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const listTools = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  test('GBRAIN_HTTP_RATE_LIMIT_IP throttles an address before the token lookup', async () => {
    await withEnv({ ...UNSET, GBRAIN_HTTP_RATE_LIMIT_IP: '5' }, async () => {
      const app = await startServeHttp(engine);
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 8; i++) statuses.push((await post(app.base, listTools)).status);
        expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
        const limited = await post(app.base, listTools);
        expect({ status: limited.status, retryAfter: Number(limited.headers.get('retry-after')) > 0, body: await limited.json() })
          .toEqual({ status: 429, retryAfter: true, body: { error: 'rate_limited', message: 'Too many requests' } });
      } finally { await app.close(); }
    });
  }, 120_000);

  test('GBRAIN_HTTP_RATE_LIMIT_TOKEN throttles one token and leaves another alone', async () => {
    await withEnv({ ...UNSET, GBRAIN_HTTP_RATE_LIMIT_TOKEN: '5' }, async () => {
      const app = await startServeHttp(engine);
      try {
        const [busy, quiet] = [await legacyToken(engine, ['read']), await legacyToken(engine, ['read'])];
        const statuses: number[] = [];
        for (let i = 0; i < 7; i++) statuses.push((await rpc(app.base, busy, 'tools/list')).status);
        expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
        expect((await rpc(app.base, quiet, 'tools/list')).status).toBe(200);
      } finally { await app.close(); }
    });
  }, 120_000);

  test('GBRAIN_HTTP_MAX_BODY_BYTES caps the request body', async () => {
    await withEnv({ ...UNSET, GBRAIN_HTTP_MAX_BODY_BYTES: String(1024 * 1024) }, async () => {
      const app = await startServeHttp(engine);
      try {
        const token = await legacyToken(engine, ['read']);
        const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'x'.repeat(1536 * 1024) } } });
        expect((await post(app.base, big, token)).status).toBe(413);
        expect((await rpc(app.base, token, 'tools/list')).status).toBe(200);
      } finally { await app.close(); }
    });
  }, 120_000);

  test('a body cap that is not a whole number of bytes is ignored, not read as a tiny cap', async () => {
    await withEnv({ ...UNSET, GBRAIN_HTTP_MAX_BODY_BYTES: '4MiB' }, async () => {
      const app = await startServeHttp(engine);
      try {
        const token = await legacyToken(engine, ['read']);
        expect((await rpc(app.base, token, 'tools/list')).status).toBe(200);
      } finally { await app.close(); }
    });
  }, 120_000);

  test('with no limit set, serve --http keeps its unlimited rate and 4 MiB body default', async () => {
    await withEnv(UNSET, async () => {
      const app = await startServeHttp(engine);
      try {
        const token = await legacyToken(engine, ['read']);
        const statuses = new Set<number>();
        for (let i = 0; i < 70; i++) statuses.add((await rpc(app.base, token, 'tools/list')).status);
        for (let i = 0; i < 40; i++) statuses.add((await post(app.base, listTools)).status);
        expect([...statuses].sort()).toEqual([200, 401]);
        const mid = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'x'.repeat(1536 * 1024) } } });
        expect((await post(app.base, mid, token)).status).not.toBe(413);
      } finally { await app.close(); }
    });
  }, 180_000);
});
