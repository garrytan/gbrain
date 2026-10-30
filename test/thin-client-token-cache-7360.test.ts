/**
 * #7360: a thin client reuses its OAuth access token across CLI processes.
 *
 * Every `gbrain` command is its own process, and the access token used to
 * live only in process memory, so each call minted a fresh
 * client_credentials token. A per-prompt hook then spent the host's /token
 * budget (50 per 15 minutes by default) and locked itself out with 429s.
 * The token is now cached on disk (mode 0600) under the gbrain home, keyed by
 * the issuer, MCP URL, client id and a hash of the secret, and re-minted
 * shortly before it expires.
 *
 * Trust boundary: the cache stores only the bearer the host issued. The host
 * still authorizes every request against the client's current grant
 * (verifyAccessToken intersects the token's scopes with the client's), so a
 * cached token never acts with more scope than the client holds now, and a
 * different client or secret never reuses another client's token.
 *
 * Servers: production `gbrain serve --http` (buildServeHttpApp) on an
 * ephemeral loopback port over an in-memory keyless PGLite brain.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { callRemoteTool, RemoteMcpError, _clearMcpClientTokenCache } from '../src/core/mcp-client.ts';
import { tokenCacheKey } from '../src/core/remote-token-cache.ts';
import { ownerCookie, registerOAuthClient, startServeHttp, thinClientConfig, type LiveServeHttp } from './helpers/live-mcp-servers.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let serve: LiveServeHttp;
let cookie: string;
const home = mkdtempSync(join(tmpdir(), 'gbrain-token-cache-7360-'));
const inHome = (fn: () => Promise<void>) => () => withEnv({ GBRAIN_HOME: home }, fn);
type Client = { clientId: string; clientSecret: string };
const cacheFile = (client: Client, root = home) =>
  join(root, '.gbrain', 'remote-tokens', `${tokenCacheKey(thinClientConfig(serve, client).remote_mcp!, client.clientSecret)}.json`);

async function mintedTokens(clientId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    "SELECT count(*)::int AS n FROM oauth_tokens WHERE client_id = $1 AND token_type = 'access'", [clientId]);
  return Number(rows[0]!.n);
}

/** A new CLI process: the in-process token map is gone, the gbrain home stays. */
const newProcess = () => _clearMcpClientTokenCache({ keepDisk: true });

async function errorOf(fn: () => Promise<unknown>): Promise<RemoteMcpError> {
  try { await fn(); } catch (e) { if (e instanceof RemoteMcpError) return e; throw e; }
  throw new Error('expected a RemoteMcpError');
}

beforeAll(inHome(async () => {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  serve = await startServeHttp(engine);
  cookie = await ownerCookie(serve);
}), 120_000);

afterEach(inHome(async () => { _clearMcpClientTokenCache(); }));

afterAll(async () => {
  await serve?.close();
  await engine?.disconnect();
  rmSync(home, { recursive: true, force: true });
});

describe('#7360 token reuse across processes', () => {
  test('three separate calls mint one token', inHome(async () => {
    const client = await registerOAuthClient(serve, cookie, 'read write');
    const config = thinClientConfig(serve, client);
    for (let i = 0; i < 3; i++) {
      newProcess();
      await callRemoteTool(config, 'get_brain_identity', {});
    }
    expect(await mintedTokens(client.clientId)).toBe(1);
  }), 60_000);

  test('real CLI processes share the cached token', inHome(async () => {
    const client = await registerOAuthClient(serve, cookie, 'read write');
    const cliHome = mkdtempSync(join(tmpdir(), 'gbrain-token-cache-cli-'));
    try {
      mkdirSync(join(cliHome, '.gbrain'), { recursive: true });
      writeFileSync(join(cliHome, '.gbrain', 'config.json'), JSON.stringify(thinClientConfig(serve, client), null, 2));
      for (let i = 0; i < 3; i++) {
        const r = await runCli(['search', 'hello'], { home: cliHome, timeoutMs: 60_000 });
        expect(`${r.exitCode}\n${r.stderr}`).toBe('0\n');
      }
      expect(await mintedTokens(client.clientId)).toBe(1);
      const mode = statSync(cacheFile(client, cliHome)).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(cliHome, { recursive: true, force: true });
    }
  }), 180_000);

  test('a token near expiry is re-minted', inHome(async () => {
    const client = await registerOAuthClient(serve, cookie, 'read write');
    const config = thinClientConfig(serve, client);
    await callRemoteTool(config, 'get_brain_identity', {});
    const cached = JSON.parse(readFileSync(cacheFile(client), 'utf8'));
    cached.expires_at_ms = Date.now() - 1;
    writeFileSync(cacheFile(client), JSON.stringify(cached), { mode: 0o600 });
    newProcess();
    await callRemoteTool(config, 'get_brain_identity', {});
    expect(await mintedTokens(client.clientId)).toBe(2);
  }), 60_000);

  test('a cached token the host revoked is dropped and re-minted once', inHome(async () => {
    const client = await registerOAuthClient(serve, cookie, 'read write');
    const config = thinClientConfig(serve, client);
    await callRemoteTool(config, 'get_brain_identity', {});
    await engine.executeRaw("DELETE FROM oauth_tokens WHERE client_id = $1 AND token_type = 'access'", [client.clientId]);
    newProcess();
    await callRemoteTool(config, 'get_brain_identity', {});
    expect(await mintedTokens(client.clientId)).toBe(1);
  }), 60_000);
});

describe('#7360 the cache never widens scope (trust boundary)', () => {
  test('narrowing the client on the host narrows the cached token at once', inHome(async () => {
    const client = await registerOAuthClient(serve, cookie, 'read write');
    const config = thinClientConfig(serve, client);
    await callRemoteTool(config, 'get_brain_identity', {});
    await engine.executeRaw("UPDATE oauth_clients SET scope = 'read' WHERE client_id = $1", [client.clientId]);
    newProcess();
    const err = await errorOf(() => callRemoteTool(config, 'put_page', { slug: 'notes/scope-probe-7360', content: '# probe' }));
    expect(err.detail?.code ?? err.message).toMatch(/scope/);
    await callRemoteTool(config, 'get_brain_identity', {});
    expect(await mintedTokens(client.clientId)).toBe(1);
    expect(await engine.getPage('notes/scope-probe-7360')).toBeNull();
  }), 60_000);

  test('a narrower client never reuses a broader client\'s cached token', inHome(async () => {
    const broad = await registerOAuthClient(serve, cookie, 'read write');
    const narrow = await registerOAuthClient(serve, cookie, 'read');
    await callRemoteTool(thinClientConfig(serve, broad), 'get_brain_identity', {});
    newProcess();
    const narrowConfig = thinClientConfig(serve, narrow);
    const err = await errorOf(() => callRemoteTool(narrowConfig, 'put_page', { slug: 'notes/scope-probe-7360b', content: '# probe' }));
    expect(err.detail?.code ?? err.message).toMatch(/scope/);
    expect(await mintedTokens(narrow.clientId)).toBe(1);
    expect(await engine.getPage('notes/scope-probe-7360b')).toBeNull();
  }), 60_000);

  test('in one process, a second client at the same URL gets its own token', inHome(async () => {
    const broad = await registerOAuthClient(serve, cookie, 'read write');
    const narrow = await registerOAuthClient(serve, cookie, 'read');
    await callRemoteTool(thinClientConfig(serve, broad), 'get_brain_identity', {});
    const err = await errorOf(() => callRemoteTool(thinClientConfig(serve, narrow), 'put_page', { slug: 'notes/scope-probe-7360c', content: '# probe' }));
    expect(err.detail?.code ?? err.message).toMatch(/scope/);
    expect(await mintedTokens(narrow.clientId)).toBe(1);
    expect(await engine.getPage('notes/scope-probe-7360c')).toBeNull();
  }), 60_000);

  test('a changed secret for the same client id misses the cache', inHome(async () => {
    const client = await registerOAuthClient(serve, cookie, 'read write');
    await callRemoteTool(thinClientConfig(serve, client), 'get_brain_identity', {});
    newProcess();
    const err = await errorOf(() => callRemoteTool(thinClientConfig(serve, { ...client, clientSecret: 'not-the-secret' }), 'get_brain_identity', {}));
    expect(err.reason).toBe('auth');
  }), 60_000);
});

describe('#7360 cache file hygiene', () => {
  test('the cache file is 0600 and holds no secret', inHome(async () => {
    const client = await registerOAuthClient(serve, cookie, 'read write');
    await callRemoteTool(thinClientConfig(serve, client), 'get_brain_identity', {});
    expect(statSync(cacheFile(client)).mode & 0o777).toBe(0o600);
    const text = readFileSync(cacheFile(client), 'utf8');
    expect(text).not.toContain(client.clientSecret);
    expect(text).not.toContain(client.clientId);
  }), 60_000);

  test('a group- or world-readable cache file is not trusted', inHome(async () => {
    const client = await registerOAuthClient(serve, cookie, 'read write');
    const config = thinClientConfig(serve, client);
    await callRemoteTool(config, 'get_brain_identity', {});
    chmodSync(cacheFile(client), 0o644);
    newProcess();
    await callRemoteTool(config, 'get_brain_identity', {});
    expect(await mintedTokens(client.clientId)).toBe(2);
    expect(statSync(cacheFile(client)).mode & 0o777).toBe(0o600);
  }), 60_000);

  test('a symlinked cache file is replaced, never written through', inHome(async () => {
    const client = await registerOAuthClient(serve, cookie, 'read write');
    const target = join(home, 'elsewhere.json');
    writeFileSync(target, 'untouched', { mode: 0o600 });
    mkdirSync(join(home, '.gbrain', 'remote-tokens'), { recursive: true, mode: 0o700 });
    rmSync(cacheFile(client), { force: true });
    symlinkSync(target, cacheFile(client));
    await callRemoteTool(thinClientConfig(serve, client), 'get_brain_identity', {});
    expect(readFileSync(target, 'utf8')).toBe('untouched');
    expect(lstatSync(cacheFile(client)).isSymbolicLink()).toBe(false);
    expect(existsSync(cacheFile(client))).toBe(true);
  }), 60_000);

  test('a symlinked entry is never read, even when it points at a private file holding a token', inHome(async () => {
    const client = await registerOAuthClient(serve, cookie, 'read write');
    const config = thinClientConfig(serve, client);
    await callRemoteTool(config, 'get_brain_identity', {});
    const target = join(home, 'planted.json');
    writeFileSync(target, JSON.stringify({ access_token: 'planted-token', expires_at_ms: Date.now() + 3_600_000 }), { mode: 0o600 });
    rmSync(cacheFile(client), { force: true });
    symlinkSync(target, cacheFile(client));
    newProcess();
    await callRemoteTool(config, 'get_brain_identity', {});
    expect(await mintedTokens(client.clientId)).toBe(2);
    expect(lstatSync(cacheFile(client)).isSymbolicLink()).toBe(false);
  }), 60_000);

  test('two clients keep separate entries', inHome(async () => {
    const a = await registerOAuthClient(serve, cookie, 'read');
    const b = await registerOAuthClient(serve, cookie, 'read');
    await callRemoteTool(thinClientConfig(serve, a), 'get_brain_identity', {});
    await callRemoteTool(thinClientConfig(serve, b), 'get_brain_identity', {});
    newProcess();
    await callRemoteTool(thinClientConfig(serve, a), 'get_brain_identity', {});
    await callRemoteTool(thinClientConfig(serve, b), 'get_brain_identity', {});
    expect([await mintedTokens(a.clientId), await mintedTokens(b.clientId)]).toEqual([1, 1]);
  }), 60_000);
});
