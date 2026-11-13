/**
 * mcp.default_surface_dcr is the default for OAuth clients without a surface
 * row. A legacy bearer token has no row to pre-seed, so it keeps the server
 * ceiling instead of being narrowed by the DCR default. The mounted /mcp
 * route is driven in-process over an in-memory socket (no port), PGLite only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import { Duplex, PassThrough } from 'node:stream';
import express from 'express';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { hashToken } from '../src/core/utils.ts';
import { operationsByName } from '../src/core/operations.ts';
import { mountMcp } from '../src/commands/serve-http-mcp.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { STARTER_OPS } from '../src/mcp/surface.ts';

const TOKEN = 'synthetic-legacy-dcr-' + process.pid;
const CONFIG = { engine: 'pglite', embedding_disabled: true } as const;

describe('legacy bearer token vs mcp.default_surface_dcr', () => {
  let engine: BrainEngine;
  let server: http.Server;

  beforeAll(async () => {
    const db = new PGLiteEngine();
    await db.connect({});
    await db.initSchema();
    engine = db;
    await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes) VALUES($1,$2,$3::text[])', ['Synthetic legacy token', hashToken(TOKEN), '{read,write}']);
    await engine.setConfig('mcp.default_surface_dcr', 'starter');
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const app = express();
    mountMcp(app, { engine, config: CONFIG, resourceVerifier: provider,
      resourceMetadataUrl: 'http://127.0.0.1/resource', mcpResourceUrl: new URL('http://127.0.0.1/mcp'),
      mcpOperationsBase: Object.values(operationsByName).filter(op => !op.localOnly && !op.cliOnly), broadcastEvent() {} } as unknown as ServeHttpContext);
    server = http.createServer(app);
  }, 120_000);

  afterAll(async () => { await engine.disconnect(); });

  async function toolNames(): Promise<string[]> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const inbound = new PassThrough();
    const outbound = new PassThrough();
    const socket = new Duplex({
      read() {},
      write(chunk, _enc, cb) { outbound.write(chunk); cb(); },
      final(cb) { outbound.end(); cb(); },
    }) as Duplex & { remoteAddress?: string };
    inbound.on('data', d => socket.push(d));
    socket.remoteAddress = '127.0.0.1';
    server.emit('connection', socket);
    inbound.write(`POST /mcp HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAuthorization: Bearer ${TOKEN}\r\n`
      + `Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    let raw = '';
    outbound.on('data', d => { raw += d; });
    await new Promise<void>(resolve => { outbound.on('end', resolve); outbound.on('close', resolve); });
    const payload = raw.slice(raw.indexOf('\r\n\r\n') + 4);
    const line = payload.includes('data:') ? payload.split('\n').filter(l => l.startsWith('data:')).pop()!.slice(5) : payload;
    const json = JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
    return ((json.result?.tools ?? []) as Array<{ name: string }>).map(t => t.name);
  }

  test('tools/list for a legacy token includes a non-starter op while the DCR default is starter', async () => {
    expect(STARTER_OPS.has('add_link')).toBe(false);
    expect(await toolNames()).toContain('add_link');
  }, 30_000);
});
