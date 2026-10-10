/**
 * C1 version skew (DX-1, DX-2, DX-16): who gets lean and who gets full
 * `search`/`query` rows, across client and host versions and transports.
 *
 *   client                         host                         transport          rows
 *   new thin CLI (X-Gbrain-Client) new                          OAuth HTTP         full
 *   new thin CLI                   new, strict_params=reject    OAuth HTTP         full, accepted
 *   new thin CLI                   old (no `fields`, header     any HTTP           unchanged: it sends no
 *                                  unknown)                                        `fields` (test/mcp-client.test.ts)
 *   old thin CLI (no header)       new                          OAuth HTTP         lean; `mcp.result_rows: full` -> full
 *   new / old thin CLI             new                          legacy bearer HTTP full with header, lean without
 *   third-party MCP client         new                          stdio              lean; `fields: "full"` or host
 *                                                                                  `mcp.result_rows: full` -> full;
 *                                                                                  reject mode accepts `fields`
 * Old CLI renderers read slug/score/chunk_text/stale only, which lean rows keep.
 *
 * Fails when: the thin client loses full rows (renderers, --explain), the
 * host-wide escape hatch stops working on a transport, or strict hosts
 * refuse a call the thin client makes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { callRemoteTool, unpackToolResult, _clearMcpClientTokenCache } from '../src/core/mcp-client.ts';
import { resetStrictParamsModeCache } from '../src/mcp/validate-params.ts';
import { formatResult } from '../src/cli/main.ts';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import { withEnv } from './helpers/with-env.ts';

type Row = Record<string, unknown>;
const isFull = (rows: Row[]) => rows.length > 0 && rows.every(r => 'page_id' in r && 'chunk_source' in r);
const isLean = (rows: Row[]) => rows.length > 0 && rows.every(r => !('page_id' in r) && !('chunk_source' in r) && 'chunk_id' in r && 'id' in r);

let engine: PGLiteEngine;
let server: Server;
let base: string;
let clientId: string;
let clientSecret: string;
let token: string;

async function json<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200);
  const text = await res.text();
  const data = text.split('\n').find(l => l.startsWith('data:'));
  return JSON.parse(data ? data.slice('data:'.length) : text) as T;
}

/** A raw MCP POST: what an old thin CLI or any third-party HTTP client sends (no X-Gbrain-Client). */
async function rawCall(name: string, args: Row, headers: Record<string, string> = {}): Promise<{ isError?: boolean; content: Array<{ text: string }> }> {
  const rpc = await json<{ result: { isError?: boolean; content: Array<{ text: string }> } }>(await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  return rpc.result;
}

const thinConfig = () => ({
  engine: 'postgres' as const,
  remote_mcp: { issuer_url: base, mcp_url: `${base}/mcp`, oauth_client_id: clientId, oauth_client_secret: clientSecret },
});

async function thinCall(name: string, args: Row): Promise<Row[]> {
  return unpackToolResult<Row[]>(await callRemoteTool(thinConfig() as never, name, args));
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [slug, body] of [['notes/ocelot-pricing', 'Ocelot pricing is tiered by seat.'], ['notes/ocelot-roadmap', 'The ocelot roadmap ships pricing changes next quarter.']]) {
    await importFromContent(engine, slug, serializeMarkdown({}, body, '', { type: 'note', title: slug, tags: [] }), { noEmbed: true, forceRechunk: true });
  }
  const app = express();
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  const built = await buildServeHttpApp(app, engine, { port, tokenTtl: 3600, enableDcr: false, publicUrl: base });
  const login = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: built.bootstrapToken }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const reg = await json<{ clientId: string; clientSecret: string }>(await fetch(`${base}/admin/api/register-client`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'skew-client', scopes: 'read write', grantTypes: ['client_credentials'] }),
  }));
  ({ clientId, clientSecret } = reg);
  token = (await json<{ access_token: string }>(await fetch(`${base}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'read write' }),
  }))).access_token;
}, 120_000);

afterAll(async () => {
  _clearMcpClientTokenCache();
  await new Promise<void>(resolve => { server?.closeAllConnections?.(); server?.close(() => resolve()); });
  await engine?.disconnect();
});

describe('OAuth HTTP host', () => {
  test('new thin CLI: full rows for search and query without sending fields', async () => {
    expect(isFull(await thinCall('search', { query: 'ocelot pricing' }))).toBe(true);
    expect(isFull(await thinCall('query', { query: 'ocelot pricing', expand: false }))).toBe(true);
  });

  test('old thin CLI or third-party client (no header): lean rows; fields "full" restores them', async () => {
    expect(isLean(JSON.parse((await rawCall('search', { query: 'ocelot pricing' })).content[0].text))).toBe(true);
    expect(isFull(JSON.parse((await rawCall('search', { query: 'ocelot pricing', fields: 'full' })).content[0].text))).toBe(true);
  });

  test('a header naming another client is not the thin client', async () => {
    const res = await rawCall('search', { query: 'ocelot pricing' }, { 'X-Gbrain-Client': 'someone-else/1.0' });
    expect(isLean(JSON.parse(res.content[0].text))).toBe(true);
  });

  test('host mcp.result_rows: full serves full rows to every remote caller, restart-free', async () => {
    await engine.setConfig('mcp.result_rows', 'full');
    try {
      expect(isFull(JSON.parse((await rawCall('search', { query: 'ocelot pricing' })).content[0].text))).toBe(true);
    } finally {
      await engine.executeRaw(`DELETE FROM config WHERE key = 'mcp.result_rows'`);
    }
    expect(isLean(JSON.parse((await rawCall('search', { query: 'ocelot pricing' })).content[0].text))).toBe(true);
  });

  test('strict_params=reject: the thin client still works, fields is accepted, an unknown key is refused', async () => {
    await engine.setConfig('mcp.strict_params', 'reject');
    resetStrictParamsModeCache();
    try {
      expect(isFull(await thinCall('search', { query: 'ocelot pricing' }))).toBe(true);
      expect((await rawCall('search', { query: 'ocelot pricing', fields: 'full' })).isError).not.toBe(true);
      expect((await rawCall('search', { query: 'ocelot pricing', row_fields: 'full' })).isError).toBe(true);
    } finally {
      await engine.executeRaw(`DELETE FROM config WHERE key = 'mcp.strict_params'`);
      resetStrictParamsModeCache();
    }
  });

  test('the CLI renderer an old thin client uses reads only fields lean rows keep', async () => {
    const rows = JSON.parse((await rawCall('search', { query: 'ocelot pricing' })).content[0].text) as Row[];
    const out = formatResult('search', rows, {});
    for (const r of rows) expect(out).toContain(`] ${r.slug} -- `);
  });
});

describe('legacy bearer HTTP transport', () => {
  test('header -> full rows, no header -> lean rows, host config -> full rows', async () => {
    const legacy = await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-skew-legacy-')) }, () => startHttpTransport({ port: 0, engine }));
    const { token: bearer } = await mintLegacyToken(engine, { name: 'skew-legacy', takesHolders: ['world'], scopes: ['read'] });
    const call = async (headers: Record<string, string> = {}) => {
      const res = await fetch(`http://127.0.0.1:${(legacy as { port: number }).port}/mcp`, {
        method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'ocelot pricing' } } }),
      });
      const body = await res.json() as { result: { content: Array<{ text: string }> } };
      return JSON.parse(body.result.content[0].text) as Row[];
    };
    try {
      expect(isFull(await call({ 'X-Gbrain-Client': 'gbrain-remote-cli/0.0.0' }))).toBe(true);
      expect(isLean(await call())).toBe(true);
      await engine.setConfig('mcp.result_rows', 'full');
      expect(isFull(await call())).toBe(true);
    } finally {
      await engine.executeRaw(`DELETE FROM config WHERE key = 'mcp.result_rows'`);
      (legacy as { stop: (force?: boolean) => void }).stop(true);
    }
  });
});

describe('stdio host (third-party MCP client)', () => {
  let home: string;

  const run = (env: Record<string, string>, ...args: string[]) => {
    const r = spawnSync('bun', ['--no-env-file', 'run', 'src/cli.ts', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${args.join(' ')} failed: ${r.stderr}`);
  };

  /** One `gbrain serve` session; closed before the next CLI write (PGLite has one holder). */
  async function session<T>(env: Record<string, string>, fn: (client: Client) => Promise<T>): Promise<T> {
    const transport = new StdioClientTransport({ command: 'bun', args: ['--no-env-file', 'run', 'src/cli.ts', 'serve'], cwd: process.cwd(), env });
    const client = new Client({ name: 'third-party-agent', version: '1' }, { capabilities: {} });
    await client.connect(transport);
    try { return await fn(client); } finally { await client.close(); }
  }

  const rows = async (client: Client, args: Row) => {
    const res = await client.callTool({ name: 'search', arguments: { query: 'ocelot pricing', ...args } });
    expect(res.isError).not.toBe(true);
    return JSON.parse((res.content as Array<{ text: string }>)[0].text) as Row[];
  };

  let env: Record<string, string>;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-skew-stdio-'));
    env = keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined }) as Record<string, string>;
    delete env.GBRAIN_SOURCE;
    run(env, 'init', '--pglite', '--no-embedding', '--non-interactive');
    const notes = join(home, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'ocelot.md'), '---\ntitle: Ocelot pricing\n---\n\nOcelot pricing is tiered by seat.\n');
    run(env, 'import', notes, '--no-embed');
  }, 120_000);

  afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  test('lean by default; fields "full" restores full rows', async () => {
    await session(env, async client => {
      expect(isLean(await rows(client, {}))).toBe(true);
      expect(isFull(await rows(client, { fields: 'full' }))).toBe(true);
    });
  }, 60_000);

  test('host mcp.result_rows: full (read at serve start) serves full rows', async () => {
    run(env, 'config', 'set', 'mcp.result_rows', 'full');
    try {
      expect(await session(env, async client => isFull(await rows(client, {})))).toBe(true);
    } finally {
      run(env, 'config', 'unset', 'mcp.result_rows');
    }
  }, 60_000);

  test('strict_params=reject accepts fields', async () => {
    run(env, 'config', 'set', 'mcp.strict_params', 'reject');
    try {
      expect(await session(env, async client => isFull(await rows(client, { fields: 'full' })))).toBe(true);
    } finally {
      run(env, 'config', 'unset', 'mcp.strict_params');
    }
  }, 60_000);
});
