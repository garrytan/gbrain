/**
 * GBRA-199: a harness or bot grant a gbrain install path mints (`gbrain mcp
 * provision` profiles, `gbrain agent register` presets) calls the full
 * surface but lists only the memory verbs and request_tools over HTTP, like a
 * stdio registration with `--advertise verbs`. An operator's explicit surface
 * lists that surface in full, and a grant that was operator-pinned before
 * keeps its listing when a profile is applied again.
 *
 * Fails when: a provisioned client lists the whole catalog, an unlisted tool
 * stops being callable, or an operator pin is narrowed to the verbs.
 * PGLite in-memory, the production app from buildServeHttpApp over real HTTP.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { readClientGrant, resolveGrantProfile } from '../src/core/grants/service.ts';
import { provisionHarnessGrant } from '../src/commands/mcp-provision.ts';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';
import { resolvePreset } from '../src/commands/agent-register.ts';
import { operations } from '../src/core/operations.ts';
import { filterOpsForSurface, INSTALL_SURFACE_SET_BY } from '../src/mcp/surface.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;
let home: string;
let server: Server;
let base: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-install-listing-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('eval.capture', 'false');
  provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const app = express();
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  base = `http://127.0.0.1:${address.port}`;
  await buildServeHttpApp(app, engine, { port: address.port, tokenTtl: 3600, enableDcr: false, publicUrl: base });
}, 120_000);

afterAll(async () => {
  await new Promise<void>(resolve => { server?.closeAllConnections?.(); server?.close(() => resolve()); });
  await engine?.disconnect();
  rmSync(home, { recursive: true, force: true });
}, 30_000);

async function token(clientId: string, secret: string): Promise<string> {
  const res = await fetch(`${base}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope: 'read write' }),
  });
  expect(res.status).toBe(200);
  return (await res.json() as { access_token: string }).access_token;
}

async function rpc(bearer: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const data = text.split('\n').find(l => l.startsWith('data:'));
  return JSON.parse(data ? data.slice('data:'.length) : text).result;
}

const listed = async (bearer: string) => (await rpc(bearer, 'tools/list')).tools.map((t: { name: string }) => t.name).sort();
const VERBS_LISTING = [...filterOpsForSurface(operations, 'verbs').map(o => o.name), 'request_tools'].sort();

describe('install-default grants list the memory verbs over HTTP', () => {
  test('a provisioned memory-writer lists the verbs and request_tools, and an unlisted write stays callable', async () => {
    const created = await withEnv({ GBRAIN_HOME: home }, () => provisionHarnessGrant(engine,
      { name: 'listing-writer-example', harness: 'generic', url: `${base}/mcp`, profile: 'memory-writer' }, 'test'));
    expect(created.grant.surface).toBe('full');
    expect(created.grant.surfaceSetBy).toBe(INSTALL_SURFACE_SET_BY);
    const bearer = await token(created.grant.clientId, created.credentials!.client_secret!);
    expect(await listed(bearer)).toEqual(VERBS_LISTING);
    const put = await rpc(bearer, 'tools/call', { name: 'put_page', arguments: { slug: 'notes/install-listing', content: '---\ntype: note\ntitle: Install listing\n---\nCallable while unlisted.\n' } });
    expect(put.isError, put.content?.[0]?.text).toBeFalsy();
    const described = await rpc(bearer, 'tools/call', { name: 'request_tools', arguments: { tools: ['put_page'] } });
    expect(JSON.parse(described.content[0].text).tools.map((t: { name: string }) => t.name)).toEqual(['put_page']);
  }, 60_000);

  test('an operator rescope to --surface full lists the whole surface', async () => {
    const created = await withEnv({ GBRAIN_HOME: home }, () => provisionHarnessGrant(engine,
      { name: 'listing-operator-example', harness: 'generic', url: `${base}/mcp`, profile: 'memory-writer' }, 'test'));
    await provider.rescopeClient(created.grant.clientId, { surface: 'full' });
    expect((await readClientGrant(engine, created.grant.clientId)).surfaceSetBy).toBe('operator');
    const names = await listed(await token(created.grant.clientId, created.credentials!.client_secret!));
    expect(names).toContain('put_page');
    expect(names.length).toBeGreaterThan(VERBS_LISTING.length);
  }, 60_000);

  test('a grant pinned by the operator before keeps its full listing when a profile is applied again', async () => {
    const pinned = { ...resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' }), surfaceSetBy: 'operator' };
    const created = await provider.registerClientManual('listing-pinned-example', ['client_credentials'], 'read write', [], 'default',
      undefined, undefined, undefined, pinned);
    const existing = await readClientGrant(engine, created.clientId);
    expect(resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default', existing }).surfaceSetBy).toBe('operator');
    expect(await listed(await token(created.clientId, created.clientSecret!))).toContain('put_page');
  }, 60_000);

  test('agent register presets mark their own full surface; an explicit --surface is an operator pin', () => {
    const base = { name: 'preset-example', federatedRead: ['proj-example'] } as const;
    expect(resolvePreset({ ...base, preset: 'daily-driver' } as any).surfaceSetBy).toBe(INSTALL_SURFACE_SET_BY);
    expect(resolvePreset({ ...base, preset: 'coding-agent' } as any).surfaceSetBy).toBe(INSTALL_SURFACE_SET_BY);
    expect(resolvePreset({ ...base, preset: 'daily-driver', surface: 'full' } as any).surfaceSetBy).toBeUndefined();
  });
});
