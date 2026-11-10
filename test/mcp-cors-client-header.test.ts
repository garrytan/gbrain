/**
 * #8683: a browser MCP client on an allowlisted origin may send X-Gbrain-Client.
 *
 * Protects: both HTTP transports (the OAuth serve --http mount and the legacy bearer transport) list the header in
 * their CORS preflight's Access-Control-Allow-Headers, from one shared list, so a browser client that names itself
 * is not blocked before its request is sent. The header selects result-row shape only, never authority.
 * Fails when: either transport's allow-list drops the header, or the two lists drift apart.
 * Seams: the mounted SDK transport and the legacy Bun transport over real sockets. PGLite only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { GBRAIN_CLIENT_HEADER } from '../src/mcp/result-rows.ts';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';
import { withEnv } from './helpers/with-env.ts';

describe('#8683 CORS preflight allows X-Gbrain-Client on both HTTP transports', () => {
  const ORIGIN = 'https://allowed.example';
  let engine: BrainEngine;
  let http: Server;
  let legacy: { port: number; stop: (force?: boolean) => unknown };

  beforeAll(async () => {
    const db = new PGLiteEngine();
    await db.connect({});
    await db.initSchema();
    engine = db;
    await withEnv({ GBRAIN_HTTP_CORS_ORIGIN: ORIGIN }, async () => {
      const app = express();
      http = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
      const port = (http.address() as AddressInfo).port;
      await buildServeHttpApp(app, engine, { port, tokenTtl: 3600, enableDcr: false, publicUrl: 'http://127.0.0.1:' + port });
      legacy = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
        ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
        token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      } }) as unknown as { port: number; stop: (force?: boolean) => unknown };
    });
  }, 120_000);

  afterAll(async () => {
    await legacy?.stop(true);
    if (http) await new Promise<void>(resolve => { http.closeAllConnections?.(); http.close(() => resolve()); });
    await engine.disconnect();
  });

  const allowed = async (port: number) => {
    const response = await fetch('http://127.0.0.1:' + port + '/mcp', { method: 'OPTIONS', headers: {
      Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type, x-gbrain-client' } });
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    return (response.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(/\s*,\s*/);
  };

  test('the OAuth serve --http mount and the legacy transport allow the same headers, X-Gbrain-Client included', async () => {
    const oauth = await allowed((http.address() as AddressInfo).port);
    const bearer = await allowed(legacy.port);
    expect(oauth).toContain(GBRAIN_CLIENT_HEADER.toLowerCase());
    expect(bearer).toContain(GBRAIN_CLIENT_HEADER.toLowerCase());
    expect([...bearer].sort()).toEqual([...oauth].sort());
  });
});
