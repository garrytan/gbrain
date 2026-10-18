/**
 * #6721: one config snapshot per request.
 *
 * 1. Protects: a remote MCP `search` (stdio dispatch and POST /mcp) reads the
 *    config table once, and a request still reads its own config writes.
 * 2. Fails when: a search-path module reads a key one statement at a time
 *    again, dispatch or the /mcp route stops opening the snapshot, or the
 *    snapshot outlives its request (stale config after it settles).
 * 3. Existing coverage: test/search-mode-config-snapshot.test.ts pins only the
 *    mode loader; nothing counted the reads of a whole request.
 *    Contributed by @troyhoffman-oss (#6734); revised for the LHF wave 2.
 * 4. Seam: none. Statements are counted on the PGLite handle the engine uses.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';
import { withRequestConfigSnapshot, withoutRequestConfigSnapshot } from '../src/core/config-snapshot.ts';

let engine: PGLiteEngine;
let server: Server;
let base: string;
let token: string;
const configStatements: string[] = [];

async function json<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200);
  const text = await res.text();
  const data = text.split('\n').find(l => l.startsWith('data:'));
  return JSON.parse(data ? data.slice('data:'.length) : text) as T;
}

/** Config-table statements issued while `fn` runs. */
async function countConfigStatements(fn: () => Promise<unknown>): Promise<string[]> {
  configStatements.length = 0;
  await fn();
  return [...configStatements];
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (let i = 0; i < 3; i++) {
    await importFromContent(engine, `notes/widget-${i}`, serializeMarkdown({}, `Widget renewal terms, note ${i}.`, '', { type: 'note', title: `Widget ${i}`, tags: [] }), { noEmbed: true, forceRechunk: true });
  }
  const db = engine.db as unknown as { query: (sql: string, ...rest: unknown[]) => Promise<unknown> };
  const query = db.query.bind(db);
  db.query = (sql: string, ...rest: unknown[]) => {
    if (/\bFROM config\b/i.test(sql)) configStatements.push(sql.replace(/\s+/g, ' ').trim());
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
    body: JSON.stringify({ name: 'snapshot-client', scopes: 'read', grantTypes: ['client_credentials'] }),
  }));
  token = (await json<{ access_token: string }>(await fetch(`${base}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: reg.clientId, client_secret: reg.clientSecret, scope: 'read' }),
  }))).access_token;
}, 120_000);

afterAll(async () => {
  await new Promise<void>(resolve => { server?.closeAllConnections?.(); server?.close(() => resolve()); });
  await engine?.disconnect();
});

describe('a remote search reads the config table once', () => {
  test('stdio/HTTP dispatch', async () => {
    const reads = await countConfigStatements(async () => {
      const r = await dispatchToolCall(engine, 'search', { query: 'widget renewal', limit: 5 }, { remote: true, transport: 'http', sourceId: 'default' });
      expect(r.isError).toBeFalsy();
      expect((JSON.parse(r.content[0].text!) as unknown[]).length).toBeGreaterThan(0);
    });
    expect(reads.filter(sql => sql === 'SELECT key, value FROM config')).toHaveLength(1);
    expect(reads.filter(sql => sql.startsWith('SELECT value FROM config WHERE key'))).toEqual([]);
  });

  test('POST /mcp: the route reads and the dispatched search share one snapshot', async () => {
    const post = () => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'widget renewal', limit: 5 } } }),
    });
    // The client's first call carries the one-time behavior-change disclosure, whose trust-claim read is its own statement.
    await json(await post());
    const reads = await countConfigStatements(async () => {
      const rpc = await json<{ result: { isError?: boolean; content: Array<{ text: string }> } }>(await post());
      expect(rpc.result.isError).toBeFalsy();
      expect((JSON.parse(rpc.result.content[0].text) as unknown[]).length).toBeGreaterThan(0);
    });
    // Token verification runs before the route and may read config on its own; the route reads the table once.
    expect(reads.filter(sql => sql === 'SELECT key, value FROM config')).toHaveLength(1);
    expect(reads.filter(sql => sql.startsWith('SELECT value FROM config WHERE key'))).toEqual([]);
  });
});

describe('the snapshot is scoped to its request', () => {
  test('a request reads its own engine writes; reads after it settles are live', async () => {
    await engine.unsetConfig('test.request_snapshot');
    await withRequestConfigSnapshot(engine, async () => {
      expect(await engine.getConfig('test.request_snapshot')).toBeNull();
      await engine.setConfig('test.request_snapshot', 'one');
      expect(await engine.getConfig('test.request_snapshot')).toBe('one');
      expect((await engine.getAllConfig())['test.request_snapshot']).toBe('one');
      // A write by another path inside the request is not seen until the request ends.
      await engine.executeRaw(`UPDATE config SET value = 'two' WHERE key = 'test.request_snapshot'`);
      expect(await engine.getConfig('test.request_snapshot')).toBe('one');
      await engine.unsetConfig('test.request_snapshot');
      expect(await engine.getConfig('test.request_snapshot')).toBeNull();
    });
    await engine.setConfig('test.request_snapshot', 'three');
    expect(await engine.getConfig('test.request_snapshot')).toBe('three');
    await engine.unsetConfig('test.request_snapshot');
  });

  test('a write op inside a request reads config live', async () => {
    await engine.setConfig('test.request_snapshot', 'before');
    const seen = await withRequestConfigSnapshot(engine, async () => {
      expect(await engine.getConfig('test.request_snapshot')).toBe('before');
      await engine.executeRaw(`UPDATE config SET value = 'after' WHERE key = 'test.request_snapshot'`);
      return withoutRequestConfigSnapshot(() => engine.getConfig('test.request_snapshot'));
    });
    expect(seen).toBe('after');
    await engine.unsetConfig('test.request_snapshot');
  });

  test('work a request started reads live once the request has settled', async () => {
    await engine.setConfig('test.request_snapshot', 'old');
    let later: Promise<string | null> = Promise.resolve(null);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await withRequestConfigSnapshot(engine, async () => {
      expect(await engine.getConfig('test.request_snapshot')).toBe('old');
      later = gate.then(() => engine.getConfig('test.request_snapshot'));
    });
    await engine.executeRaw(`UPDATE config SET value = 'new' WHERE key = 'test.request_snapshot'`);
    release();
    expect(await later).toBe('new');
    await engine.unsetConfig('test.request_snapshot');
  });

  test('a write op inside a request drops the snapshot, so a later read retakes it', async () => {
    await engine.setConfig('test.request_snapshot', 'first');
    await withRequestConfigSnapshot(engine, async () => {
      expect(await engine.getConfig('test.request_snapshot')).toBe('first');
      await withoutRequestConfigSnapshot(() => engine.executeRaw(`UPDATE config SET value = 'second' WHERE key = 'test.request_snapshot'`));
      expect(await engine.getConfig('test.request_snapshot')).toBe('second');
    });
    await engine.unsetConfig('test.request_snapshot');
  });

  test('another engine object and a failed bulk read both read each key live', async () => {
    await engine.setConfig('test.request_snapshot', 'live');
    const other = Object.create(engine) as PGLiteEngine;
    const failing = Object.assign(Object.create(engine) as PGLiteEngine, { getAllConfig: async () => { throw new Error('bulk read sentinel'); } });
    await withRequestConfigSnapshot(engine, async () => {
      expect(await engine.getConfig('test.request_snapshot')).toBe('live');
      await engine.executeRaw(`UPDATE config SET value = 'changed' WHERE key = 'test.request_snapshot'`);
      expect(await other.getConfig('test.request_snapshot')).toBe('changed');
    });
    const reads = await countConfigStatements(() => withRequestConfigSnapshot(failing, async () => {
      expect(await failing.getConfig('test.request_snapshot')).toBe('changed');
      expect(await failing.getConfig('test.request_snapshot')).toBe('changed');
    }));
    expect(reads.filter(sql => sql.startsWith('SELECT value FROM config WHERE key'))).toHaveLength(2);
    await engine.unsetConfig('test.request_snapshot');
  });
});
