/**
 * Thin clients reuse one OAuth access token across CLI processes.
 *
 * Every `gbrain` CLI invocation is its own process, so an in-memory token cache
 * alone mints once per call; a per-prompt caller (an agent recall hook) then
 * spends the host's /token budget and gets 429 (#2463, #5949). The token is
 * kept in a 0600 record beside config.json, matched on mcp_url + client_id,
 * reused until its skewed expiry, dropped on a 401, and never written when the
 * secret comes from GBRAIN_REMOTE_CLIENT_SECRET.
 *
 * Loopback OAuth + JSON-RPC fixture only. Every test body runs with
 * GBRAIN_HOME scoped to its own temp dir via withEnv (isolation rule R1).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test as testRaw } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { callRemoteTool, listRemoteTools, tokenFilePath, _clearMcpClientTokenCache } from '../src/core/mcp-client.ts';
import { configPath, loadConfig } from '../src/core/config.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

let server: ReturnType<typeof Bun.serve>;
let port: number;
let mints = 0;
/** When set, /token answers 500 instead of minting. */
let tokenDown = false;
let expiresIn = 3600;
/** Upcoming /mcp POSTs that answer 401 before the fixture recovers. */
let mcp401 = 0;
/** Bearers presented on /mcp tools/call, in order. */
let bearers: string[] = [];
let home: string;

function test(name: string, fn: () => void | Promise<unknown>): void {
  testRaw(name, async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-token-reuse-'));
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_REMOTE_CLIENT_SECRET: undefined }, async () => {
        _clearMcpClientTokenCache();
        await fn();
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

beforeAll(() => {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/.well-known/oauth-authorization-server') {
      return Response.json({ issuer: `http://127.0.0.1:${port}`, token_endpoint: `http://127.0.0.1:${port}/token` });
    }
    if (path === '/token') {
      if (tokenDown) return new Response('down', { status: 500 });
      mints++;
      return Response.json({ access_token: `tok-${mints}`, token_type: 'bearer', expires_in: expiresIn, scope: 'read write admin' });
    }
    if (path === '/mcp' && req.method === 'POST') {
      if (mcp401 > 0) {
        mcp401--;
        return Response.json({ error: 'invalid_token' }, { status: 401 });
      }
      const body = await req.json() as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === 'tools/call') bearers.push((req.headers.get('authorization') ?? '').replace(/^Bearer /, ''));
      const result = body.method === 'initialize'
        ? { protocolVersion: body.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'token-reuse-fixture', version: '1' } }
        : body.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
        : body.method === 'tools/list' ? { tools: [] } : {};
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }
    return new Response(null, { status: path === '/mcp' ? 405 : 404 });
  } });
  port = server.port!;
});

afterAll(async () => { await server.stop(true); });

beforeEach(() => {
  mints = 0;
  tokenDown = false;
  expiresIn = 3600;
  mcp401 = 0;
  bearers = [];
});

function config(overrides: { mcp_url?: string; oauth_client_id?: string } = {}): GBrainConfig {
  return { engine: 'pglite', remote_mcp: {
    issuer_url: `http://127.0.0.1:${port}`,
    mcp_url: overrides.mcp_url ?? `http://127.0.0.1:${port}/mcp`,
    oauth_client_id: overrides.oauth_client_id ?? 'cid',
    oauth_client_secret: 'csecret',
  } };
}

/** Run one callRemoteTool in a fresh bun process against the current GBRAIN_HOME. */
async function callInChild(): Promise<number> {
  const script = `
    import { callRemoteTool } from ${JSON.stringify(join(import.meta.dir, '../src/core/mcp-client.ts'))};
    import { loadConfig } from ${JSON.stringify(join(import.meta.dir, '../src/core/config.ts'))};
    await callRemoteTool(loadConfig()!, 'get_brain_identity');
  `;
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home };
  for (const name of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_REMOTE_CLIENT_SECRET']) delete env[name];
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try { return await child.exited; } finally { clearTimeout(watchdog); }
}

/** Drop only the in-process cache, as a new CLI process would start. */
function newProcess(): void {
  const onDisk = readFileSync(tokenFilePath(), 'utf-8');
  _clearMcpClientTokenCache();
  writeFileSync(tokenFilePath(), onDisk, { mode: 0o600 });
}

describe('thin-client token reuse across processes', () => {
  test('separate processes reuse one token instead of minting per call', async () => {
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), JSON.stringify(config()));
    for (let i = 0; i < 3; i++) expect(await callInChild()).toBe(0);
    expect(mints).toBe(1);
    expect(new Set(bearers).size).toBe(1);
  });

  test('a token at or near expiry is re-minted', async () => {
    expiresIn = 20; // inside the 30s skew: expired as soon as it is minted
    await callRemoteTool(config(), 'get_brain_identity');
    newProcess();
    await callRemoteTool(config(), 'get_brain_identity');
    expect(mints).toBe(2);
  });

  test('a 401 drops the shared token, re-mints once and retries', async () => {
    await callRemoteTool(config(), 'get_brain_identity');
    newProcess();
    mcp401 = 1;
    await callRemoteTool(config(), 'get_brain_identity');
    expect(mints).toBe(2);
    expect(JSON.parse(readFileSync(tokenFilePath(), 'utf-8')).access_token).toBe('tok-2');
  });

  test('a second 401 after the refresh forgets the refreshed token too', async () => {
    mcp401 = 2;
    await expect(callRemoteTool(config(), 'get_brain_identity')).rejects.toMatchObject({ reason: 'auth_after_refresh' });
    expect(mints).toBe(2);
    expect(existsSync(tokenFilePath())).toBe(false);
    await callRemoteTool(config(), 'get_brain_identity');
    expect(mints).toBe(3); // the rejected tok-2 is not presented again
    expect(bearers).toEqual(['tok-3']);
  });

  test('listRemoteTools on a 401 drops the shared token even when the re-mint fails', async () => {
    await callRemoteTool(config(), 'get_brain_identity');
    newProcess();
    mcp401 = 1;
    tokenDown = true;
    await expect(listRemoteTools(config())).rejects.toMatchObject({ reason: 'token' });
    expect(existsSync(tokenFilePath())).toBe(false); // the next process will not present tok-1
  });

  test('listRemoteTools forgets a refreshed token the server also rejects', async () => {
    mcp401 = 2;
    await expect(listRemoteTools(config())).rejects.toBeDefined();
    expect(mints).toBe(2);
    expect(existsSync(tokenFilePath())).toBe(false);
  });

  test('the record is 0600, written without leftovers, and holds no secret', async () => {
    await callRemoteTool(config(), 'get_brain_identity');
    expect(statSync(tokenFilePath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(tokenFilePath())).filter(f => f.includes('.tmp.'))).toEqual([]);
    expect(readFileSync(tokenFilePath(), 'utf-8')).not.toContain('csecret');
  });

  test('a different mcp_url or client_id does not share a token', async () => {
    await callRemoteTool(config(), 'get_brain_identity');
    newProcess();
    await callRemoteTool(config({ oauth_client_id: 'cid-2' }), 'get_brain_identity');
    expect(mints).toBe(2);
    newProcess();
    await callRemoteTool(config({ mcp_url: `http://localhost:${port}/mcp` }), 'get_brain_identity');
    expect(mints).toBe(3);
  });

  test('a corrupt record is a cache miss, not an error', async () => {
    mkdirSync(dirname(tokenFilePath()), { recursive: true });
    writeFileSync(tokenFilePath(), '{not json', { mode: 0o600 });
    await callRemoteTool(config(), 'get_brain_identity');
    expect(mints).toBe(1);
  });

  test('an env-only secret keeps the token in memory, never on disk', async () => {
    // Through the real loader: init keeps an env secret out of config.json,
    // and loadConfig() copies GBRAIN_REMOTE_CLIENT_SECRET into remote_mcp.
    const fileConfig = config();
    delete fileConfig.remote_mcp!.oauth_client_secret;
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), JSON.stringify(fileConfig));
    await withEnv({ GBRAIN_REMOTE_CLIENT_SECRET: 'csecret', GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined }, async () => {
      const loaded = loadConfig()!;
      expect(loaded.remote_mcp?.oauth_client_secret).toBe('csecret');
      await callRemoteTool(loaded, 'get_brain_identity');
      await callRemoteTool(loaded, 'get_brain_identity');
    });
    expect(mints).toBe(1);
    expect(existsSync(tokenFilePath())).toBe(false);
  });
});
