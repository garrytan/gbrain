/**
 * Protect legacy publishers' explicitly configured host ceiling while OAuth
 * clients retain their starter default. Removing the legacy-principal branch
 * hides add_link as unknown_tool. Existing transport tests do not combine a
 * legacy operation grant with a narrow OAuth default. Real HTTP and the native
 * verifier are used; no production seam or paid provider is needed.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const servers: Server[] = [];
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('mcp.default_surface_dcr', 'starter');
});
afterAll(async () => {
  for (const s of servers) await new Promise<void>(resolve => { s.closeAllConnections?.(); s.close(() => resolve()); });
  await engine.disconnect();
});
async function start(surface: 'full' | 'starter' = 'full') {
  const app = express();
  const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  await buildServeHttpApp(app, engine, { port: address.port, tokenTtl: 3600, enableDcr: false, publicUrl: base, surface });
  return base;
}
async function rpc(base: string, token: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const data = text.split('\n').find(line => line.startsWith('data:'));
  const envelope = JSON.parse(data ? data.slice(5) : text);
  expect(envelope.error).toBeUndefined();
  return envelope.result;
}
const linkArgs = { from: 'missing-origin', to: 'missing-target', dry_run: true };

test('legacy full host retains exact operations and source grants with an OAuth starter default', async () => {
  const base = await start();
  const name = 'legacy-publisher-surface';
  const { token } = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: [], sourceGrant: ['default'], allowedOperations: ['whoami', 'add_link'] });
  const before = await engine.executeRaw('SELECT scopes, permissions FROM access_tokens WHERE name=$1', [name]);
  const names = (await rpc(base, token, 'tools/list')).tools.map((t: { name: string }) => t.name);
  expect(names).toContain('add_link');
  expect(names).not.toContain('put_page');
  const called = await rpc(base, token, 'tools/call', { name: 'add_link', arguments: linkArgs });
  expect(JSON.parse(called.content[0].text)).toMatchObject({ dry_run: true, action: 'add_link', from: linkArgs.from, to: linkArgs.to });
  const denied = await rpc(base, token, 'tools/call', { name: 'put_page', arguments: { slug: 'not-permitted', content: '# Not permitted' } });
  expect(denied.isError).toBe(true);
  expect(await engine.getPage('not-permitted', { sourceId: 'default' })).toBeNull();
  const after = await engine.executeRaw('SELECT scopes, permissions FROM access_tokens WHERE name=$1', [name]);
  expect(after).toEqual(before);
});

test('a new OAuth client with no surface row still receives starter', async () => {
  const base = await start();
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))), tokenTtl: 3600, resourceUrl: new URL('/mcp', base) });
  const client = await provider.registerClientManual('oauth-default-surface', ['client_credentials'], 'read write');
  const minted = await provider.exchangeClientCredentials(client.clientId, client.clientSecret!, 'read write');
  const names = (await rpc(base, minted.access_token, 'tools/list')).tools.map((t: { name: string }) => t.name);
  expect(names).not.toContain('add_link');
  const hidden = await rpc(base, minted.access_token, 'tools/call', { name: 'add_link', arguments: linkArgs });
  expect(JSON.parse(hidden.content[0].text).code).toBe('unknown_tool');
});

test('legacy tokens cannot exceed the host starter ceiling or force-surface kill switch', async () => {
  const { token } = await mintLegacyToken(engine, { name: 'legacy-narrow-ceiling', scopes: ['read', 'write'], takesHolders: [] });
  const base = await start('starter');
  const hidden = await rpc(base, token, 'tools/call', { name: 'add_link', arguments: linkArgs });
  expect(JSON.parse(hidden.content[0].text).code).toBe('unknown_tool');
  await withEnv({ GBRAIN_MCP_FORCE_SURFACE: 'verbs' }, async () => {
    const full = await start('full');
    const names = (await rpc(full, token, 'tools/list')).tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain('add_link');
    const refused = await rpc(full, token, 'tools/call', { name: 'add_link', arguments: linkArgs });
    expect(JSON.parse(refused.content[0].text).code).toBe('unknown_tool');
  });
});
