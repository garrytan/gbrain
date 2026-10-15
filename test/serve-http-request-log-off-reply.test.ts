/**
 * #6721: POST /mcp replies without waiting for its mcp_request_log insert.
 *
 * 1. Protects: a tools/call reply is not held behind the audit-row write (one
 *    database round trip per call), and the row still lands afterwards; a
 *    failed insert never fails the call.
 * 2. Fails when: the route awaits the request-log insert again (the reply
 *    waits on the held insert below and the race times out), or the insert
 *    stops being written once released.
 * 3. Existing coverage: test/denied-after-list.test.ts, test/mcp-usage.test.ts
 *    and test/accepted-pending-status.test.ts pin each row's columns, not
 *    whether the reply waits for it.
 * 4. Seam: none. The insert is held and failed on the PGLite handle the
 *    engine uses; requests go through buildServeHttpApp over real HTTP.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';

let engine: PGLiteEngine;
let server: Server;
let base: string;
let token: string;
let hold: Promise<void> | null = null;
let failInsert = false;

async function json<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200);
  const text = await res.text();
  const data = text.split('\n').find(l => l.startsWith('data:'));
  return JSON.parse(data ? data.slice('data:'.length) : text) as T;
}

function callTool(name: string, args: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
}

async function logRows(operation: string): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM mcp_request_log WHERE operation = $1`, [operation]);
  return row.n;
}

async function waitForRows(operation: string, n: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  let seen = await logRows(operation);
  while (seen < n && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    seen = await logRows(operation);
  }
  return seen;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const db = engine.db as unknown as { query: (sql: string, ...rest: unknown[]) => Promise<unknown> };
  const query = db.query.bind(db);
  db.query = async (sql: string, ...rest: unknown[]) => {
    if (/^\s*INSERT INTO mcp_request_log\b/.test(sql)) {
      if (hold) await hold;
      if (failInsert) throw new Error('request log unavailable');
    }
    return query(sql, ...rest);
  };
  const app = express();
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  const built = await buildServeHttpApp(app, engine, { port, tokenTtl: 3600, enableDcr: false, publicUrl: base });
  const login = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: built.bootstrapToken }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const reg = await json<{ clientId: string; clientSecret: string }>(await fetch(`${base}/admin/api/register-client`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'request-log-client', scopes: 'read', grantTypes: ['client_credentials'] }),
  }));
  token = (await json<{ access_token: string }>(await fetch(`${base}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: reg.clientId, client_secret: reg.clientSecret, scope: 'read' }),
  }))).access_token;
}, 120_000);

afterAll(async () => {
  hold = null;
  await new Promise<void>(resolve => { server?.closeAllConnections?.(); server?.close(() => resolve()); });
  await engine?.disconnect();
});

describe('POST /mcp request log', () => {
  test('the reply arrives while its request-log insert is still held, and the row lands once released', async () => {
    let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    const before = await logRows('get_brain_identity');
    const reply = callTool('get_brain_identity', {}).then(res => json<{ result: { isError?: boolean } }>(res));
    const timedOut = new Promise<'held'>(resolve => setTimeout(() => resolve('held'), 3_000));
    const first = await Promise.race([reply, timedOut]);
    expect(first).not.toBe('held');
    expect((await reply).result.isError).toBeFalsy();
    expect(await logRows('get_brain_identity')).toBe(before);
    hold = null;
    release();
    expect(await waitForRows('get_brain_identity', before + 1)).toBe(before + 1);
  });

  test('a failed request-log insert does not fail the call', async () => {
    failInsert = true;
    try {
      const rpc = await json<{ result: { isError?: boolean } }>(await callTool('get_brain_identity', {}));
      expect(rpc.result.isError).toBeFalsy();
    } finally {
      failInsert = false;
    }
  });
});
