/**
 * POST /mcp dispatch contract across the serve-http-mcp.ts decomposition
 * (refactor wave 1, TE1).
 *
 * Protects: the options object the HTTP transport hands to
 * `dispatchToolCall`: remote: true, transport 'http', the fail-closed
 * takesHoldersAllowList default, the token's sourceId, the verified
 * AuthInfo, metaHook, the per-request surface / surfaceCeiling / allowedOps
 * and the stderr logger, with exactly today's key set.
 * Fails when: the decomposed handler drops or renames a dispatch option,
 * passes a stale surface, or widens allowedOps.
 * Why new: outcome tests show remote/auth/surface indirectly; nothing pinned
 * the literal dispatch context the handler builds.
 *
 * Serial: mock.module wraps the real dispatcher to record its arguments.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getBrainHotMemoryMeta } from '../src/core/facts/meta-hook.ts';
import { operations } from '../src/core/operations.ts';
import { filterOpsForSurface } from '../src/mcp/surface.ts';
import * as realDispatch from '../src/mcp/dispatch.ts';

type DispatchArgs = Parameters<typeof realDispatch.dispatchToolCall>;
const calls: Array<{ name: string; opts: NonNullable<DispatchArgs[3]> }> = [];
const passthrough = { ...realDispatch };
mock.module('../src/mcp/dispatch.ts', () => ({
  ...passthrough,
  dispatchToolCall: async (...args: DispatchArgs) => {
    calls.push({ name: args[1], opts: args[3] ?? {} });
    return passthrough.dispatchToolCall(...args);
  },
}));
const { buildServeHttpApp } = await import('../src/commands/serve-http.ts');

let engine: PGLiteEngine;
const servers: Server[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  for (const s of servers) await new Promise<void>(resolve => { s.closeAllConnections?.(); s.close(() => resolve()); });
  await engine.disconnect();
  mock.restore();
});

async function start(surface?: 'starter'): Promise<{ base: string; token: string; clientId: string }> {
  const app = express();
  const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  const { bootstrapToken } = await buildServeHttpApp(app, engine, { port: address.port, tokenTtl: 3600, enableDcr: false, publicUrl: base, surface });
  const login = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: bootstrapToken }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const reg = await fetch(`${base}/admin/api/register-client`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `dispatch-context-${surface ?? 'full'}`, scopes: 'read write', grantTypes: ['client_credentials'] }),
  });
  const { clientId, clientSecret } = await reg.json() as { clientId: string; clientSecret: string };
  const minted = await fetch(`${base}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'read write' }),
  });
  return { base, clientId, token: (await minted.json() as { access_token: string }).access_token };
}

async function rpc(base: string, token: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const dataLine = text.split('\n').find(l => l.startsWith('data:'));
  return JSON.parse(dataLine ? dataLine.slice('data:'.length) : text).result;
}

const FULL_SURFACE_KEYS = ['auth', 'logger', 'metaHook', 'remote', 'sourceId', 'surface', 'surfaceCeiling', 'takesHoldersAllowList', 'transport'];

describe('POST /mcp dispatch context', () => {
  test('full surface: remote http dispatch with the verified auth and token source scope', async () => {
    const { base, token, clientId } = await start();
    calls.length = 0;
    await rpc(base, token, 'tools/call', { name: 'whoami', arguments: {} });
    expect(calls.map(c => c.name)).toEqual(['whoami']);
    const { opts } = calls[0];
    expect(Object.keys(opts).sort()).toEqual(FULL_SURFACE_KEYS);
    expect(opts.remote).toBe(true);
    expect(opts.transport).toBe('http');
    expect(opts.takesHoldersAllowList).toEqual(['world']);
    expect(opts.sourceId).toBe('default');
    expect(opts.metaHook).toBe(getBrainHotMemoryMeta);
    expect(opts.surface).toBe('full');
    expect(opts.surfaceCeiling).toBe('full');
    expect(opts.auth?.clientId).toBe(clientId);
    expect(opts.auth?.scopes).toEqual(expect.arrayContaining(['read', 'write']));
    for (const level of ['info', 'warn', 'error'] as const) expect(typeof opts.logger?.[level]).toBe('function');
  });

  test('starter ceiling: allowedOps is the surface-filtered remote catalog and the surface is threaded', async () => {
    const { base, token } = await start('starter');
    const listed = (await rpc(base, token, 'tools/list')).tools.map((t: { name: string }) => t.name);
    calls.length = 0;
    await rpc(base, token, 'tools/call', { name: 'whoami', arguments: {} });
    const { opts } = calls[0];
    expect(Object.keys(opts).sort()).toEqual([...FULL_SURFACE_KEYS, 'allowedOps'].sort());
    expect(opts.surface).toBe('starter');
    expect(opts.surfaceCeiling).toBe('starter');
    const expected = filterOpsForSurface(operations.filter(op => !op.localOnly), 'starter').map(op => op.name).sort();
    expect([...opts.allowedOps!].sort()).toEqual(expected);
    for (const name of listed) expect(opts.allowedOps!.has(name)).toBe(true);
  });
});
