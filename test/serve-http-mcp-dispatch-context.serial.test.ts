/**
 * POST /mcp dispatch contract across the serve-http-mcp.ts decomposition
 * (refactor wave 1, TE1).
 *
 * Protects: the options object the HTTP transport hands to
 * `dispatchToolCall`: remote: true, transport 'http', the fail-closed
 * takesHoldersAllowList default, the token's sourceId, the verified
 * AuthInfo, metaHook, the per-request surface / surfaceCeiling / allowedOps,
 * the request-level `_meta.session_id` as sessionId (CX2-11, as stdio threads
 * it) and the stderr logger, with exactly today's key set.
 * Fails when: the decomposed handler drops or renames a dispatch option,
 * passes a stale surface, widens allowedOps, or drops the request's session.
 * Why new: outcome tests show remote/auth/surface indirectly; nothing pinned
 * the literal dispatch context the handler builds.
 *
 * Serial: mock.module wraps the real dispatcher to record its arguments.
 */

import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getBrainHotMemoryMeta } from '../src/core/facts/meta-hook.ts';
import { operations } from '../src/core/operations.ts';
import { filterOpsForSurface } from '../src/mcp/surface.ts';
import * as realDispatch from '../src/mcp/dispatch.ts';

type DispatchArgs = Parameters<typeof realDispatch.dispatchToolCall>;
const calls: Array<{ name: string; opts: NonNullable<DispatchArgs[3]>; stderrBefore: string[] }> = [];
const stderrLines: string[] = [];
const passthrough = { ...realDispatch };
mock.module('../src/mcp/dispatch.ts', () => ({
  ...passthrough,
  dispatchToolCall: async (...args: DispatchArgs) => {
    calls.push({ name: args[1], opts: args[3] ?? {}, stderrBefore: [...stderrLines] });
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

async function start(surface?: 'starter', label: string = surface ?? 'full'): Promise<{ base: string; token: string; clientId: string }> {
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
    body: JSON.stringify({ name: `dispatch-context-${label}`, scopes: 'read write', grantTypes: ['client_credentials'] }),
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

const FULL_SURFACE_KEYS = ['auth', 'logger', 'metaHook', 'noticeLedger', 'remote', 'resultRows', 'sourceId', 'surface', 'surfaceCeiling', 'takesHoldersAllowList', 'transport'];

describe('POST /mcp dispatch context', () => {
  test('full surface: remote http dispatch with the verified auth and token source scope', async () => {
    const { base, token, clientId } = await start();
    calls.length = 0;
    await rpc(base, token, 'tools/call', { name: 'whoami', arguments: {} });
    expect(calls.map(c => c.name)).toEqual(['whoami']);
    const { opts } = calls[0];
    expect(Object.keys(opts).sort()).toEqual(FULL_SURFACE_KEYS);
    expect(opts.remote).toBe(true);
    // C1: a client without the thin-client header gets the host default, lean rows.
    expect(opts.resultRows).toBe('lean');
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

  // #4817: a request that never returns must still leave its op name and an
  // argument digest behind, so the line is written before dispatch starts.
  test('logs the op name and an argument digest before dispatch, never the arguments', async () => {
    const { base, token } = await start(undefined, 'dispatch-log');
    const args = { query: 'synthetic private phrase', limit: 3 };
    const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderrLines.push(String(chunk)); return true;
    }) as typeof process.stderr.write);
    try {
      calls.length = 0;
      await rpc(base, token, 'tools/call', { name: 'search', arguments: args });
    } finally { spy.mockRestore(); }
    const digest = createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16);
    const line = `[gbrain-serve] dispatch op=search args_sha256=${digest}\n`;
    expect(calls[0].name).toBe('search');
    expect(calls[0].stderrBefore).toContain(line);
    expect(stderrLines.join('')).not.toContain('synthetic private phrase');
  });

  // CX2-11: MCP carries `_meta.session_id` beside `arguments`. Stdio threads it
  // into dispatch; over HTTP it was dropped, so a remote `remember` stored no
  // session and `recall({ session_id })` could not find the fact.
  test('the request-level _meta.session_id reaches dispatch as sessionId; without it there is none', async () => {
    const { base, token } = await start(undefined, 'session');
    calls.length = 0;
    await rpc(base, token, 'tools/call', { name: 'whoami', arguments: {}, _meta: { session_id: 'sess-http' } });
    await rpc(base, token, 'tools/call', { name: 'whoami', arguments: {} });
    expect(calls.map(c => c.name)).toEqual(['whoami', 'whoami']);
    const [withSession, withoutSession] = calls.map(c => c.opts);
    expect(withSession.sessionId).toBe('sess-http');
    expect(Object.keys(withSession).sort()).toEqual([...FULL_SURFACE_KEYS, 'sessionId'].sort());
    expect(withoutSession.sessionId).toBeUndefined();
    expect(Object.keys(withoutSession).sort()).toEqual(FULL_SURFACE_KEYS);
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
