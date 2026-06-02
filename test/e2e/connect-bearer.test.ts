/**
 * E2E for `gbrain connect`'s D4 raw-bearer smoke probe (connect-probe.ts).
 *
 * Spins up a real `gbrain serve --http` against a hermetic PGLite brain (no
 * Postgres / Docker), mints a legacy bearer token via `gbrain auth create`,
 * then drives the real MCP SDK probe against `/mcp`:
 *   - real token  → ok, returns get_brain_identity payload
 *   - wrong token → not ok, reason 'auth'
 *   - unreachable → not ok, reason 'unreachable' | 'timeout'
 *
 * This is the integration coverage the unit tests (injected deps) can't give:
 * the actual StreamableHTTP initialize handshake + tools/call over bearer auth.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { probeBrainIdentity } from '../../src/core/connect-probe.ts';
import { discoverOAuth, mintClientCredentialsToken } from '../../src/core/remote-mcp-probe.ts';

const PORT = 19735; // avoid the production 3131 + the oauth E2E's 19131
const BASE = `http://127.0.0.1:${PORT}`;
const MCP_URL = `${BASE}/mcp`;

describe('connect bearer probe E2E (PGLite + real serve --http)', () => {
  let home: string;
  let server: ChildProcess | null = null;
  let token = '';
  let oauthClientId = '';
  let oauthClientSecret = '';
  let serverReady = false;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-connect-e2e-'));
    const env = { ...process.env, GBRAIN_HOME: home };

    execFileSync('bun', ['run', 'src/cli.ts', 'init', '--pglite', '--no-embedding', '--non-interactive'], {
      cwd: process.cwd(), env, stdio: 'ignore',
    });
    const authOut = execFileSync('bun', ['run', 'src/cli.ts', 'auth', 'create', 'e2e-connect'], {
      cwd: process.cwd(), env, encoding: 'utf8',
    });
    token = (authOut.match(/gbrain_[a-f0-9]{64}/) ?? [''])[0];
    if (!token) throw new Error(`auth create did not yield a token:\n${authOut}`);

    // Register the OAuth client BEFORE spawning serve — PGLite is single-writer,
    // so register-client can't open the brain once the server holds it.
    const regOut = execFileSync('bun', [
      'run', 'src/cli.ts', 'auth', 'register-client', 'e2e-perplexity-oauth',
      '--grant-types', 'client_credentials', '--scopes', 'read write',
      '--token-endpoint-auth-method', 'client_secret_post',
    ], { cwd: process.cwd(), env, encoding: 'utf8' });
    oauthClientId = (regOut.match(/Client ID:\s+(\S+)/) ?? ['', ''])[1];
    oauthClientSecret = (regOut.match(/Client Secret:\s+(\S+)/) ?? ['', ''])[1];
    if (!oauthClientId || !oauthClientSecret) throw new Error(`register-client did not yield creds:\n${regOut}`);

    server = spawn('bun', [
      'run', 'src/cli.ts', 'serve', '--http',
      '--bind', '127.0.0.1', '--port', String(PORT),
      '--public-url', BASE,
    ], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let serr = '';
    server.stderr?.on('data', (d: Buffer) => { serr += d.toString(); });

    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) { serverReady = true; break; }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!serverReady) throw new Error(`serve --http did not become ready:\n${serr}`);
  }, 60_000);

  afterAll(() => {
    if (server) { try { server.kill('SIGTERM'); } catch { /* best-effort */ } }
    if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('real bearer token round-trips get_brain_identity', async () => {
    expect(serverReady).toBe(true);
    const r = await probeBrainIdentity(MCP_URL, token, { timeoutMs: 15_000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // get_brain_identity returns the version/engine counter packet.
      expect(r.identity).toMatch(/version/);
      expect(r.identity).toMatch(/pglite/);
    }
  }, 30_000);

  test('wrong token classifies as auth', async () => {
    expect(serverReady).toBe(true);
    const r = await probeBrainIdentity(MCP_URL, 'gbrain_deadbeef', { timeoutMs: 15_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('auth');
  }, 30_000);

  test('unreachable host classifies as unreachable or timeout', async () => {
    // 127.0.0.1:1 is reserved/closed — connection refused or fast timeout.
    const r = await probeBrainIdentity('http://127.0.0.1:1/mcp', token, { timeoutMs: 4_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['unreachable', 'timeout']).toContain(r.reason);
  }, 15_000);

  // -------------------------------------------------------------------------
  // Real-CLI coverage: drive the actual `claude` / `codex` binaries through
  // `gbrain connect --install` against the live server. Sandboxed via HOME /
  // CODEX_HOME so the dev machine's real agent config is untouched. Skips
  // gracefully when a binary isn't on PATH (e.g. CI without the CLIs).
  // -------------------------------------------------------------------------

  const hasBin = (b: string): boolean => {
    try { execFileSync(b, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
  };
  const HAS_CLAUDE = hasBin('claude');
  const HAS_CODEX = hasBin('codex');

  // Run `gbrain connect <args>` as a subprocess with extra env (HOME/CODEX_HOME
  // sandbox + GBRAIN_REMOTE_TOKEN). spawnSync captures stderr too — connect's
  // "Verified" / "Added" lines go to stderr.
  const runConnectCli = (args: string[], extraEnv: Record<string, string>): { code: number; out: string } => {
    const r = spawnSync('bun', ['run', 'src/cli.ts', 'connect', ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, GBRAIN_HOME: home, ...extraEnv },
    });
    return { code: r.status ?? 1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
  };

  (HAS_CLAUDE ? test : test.skip)('claude-code --install registers + connects against the live server', () => {
    expect(serverReady).toBe(true);
    const claudeHome = mkdtempSync(join(tmpdir(), 'gb-claude-'));
    try {
      const r = runConnectCli([MCP_URL, '--token', token, '--install', '--yes'], { HOME: claudeHome });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/Verified/);
      // The real `claude` CLI actually registered the server.
      const got = spawnSync('claude', ['mcp', 'get', 'gbrain'], { encoding: 'utf8', env: { ...process.env, HOME: claudeHome } });
      expect(got.status).toBe(0);
      expect(`${got.stdout ?? ''}${got.stderr ?? ''}`).toContain(`:${PORT}/mcp`);
    } finally {
      try { spawnSync('claude', ['mcp', 'remove', 'gbrain'], { env: { ...process.env, HOME: claudeHome } }); } catch { /* best-effort */ }
      rmSync(claudeHome, { recursive: true, force: true });
    }
  }, 60_000);

  (HAS_CODEX ? test : test.skip)('codex --install registers the env-var bearer against the live server', () => {
    expect(serverReady).toBe(true);
    const codexHome = mkdtempSync(join(tmpdir(), 'gb-codex-'));
    try {
      const r = runConnectCli([MCP_URL, '--token', token, '--agent', 'codex', '--install', '--yes'], { CODEX_HOME: codexHome, GBRAIN_REMOTE_TOKEN: token });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/Verified/);
      // The real `codex` CLI registered the streamable-http server with the
      // env-var bearer — and the token never lands in Codex config.
      const got = spawnSync('codex', ['mcp', 'get', 'gbrain'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: codexHome } });
      expect(got.status).toBe(0);
      const text = `${got.stdout ?? ''}${got.stderr ?? ''}`;
      expect(text).toContain('GBRAIN_REMOTE_TOKEN');
      expect(text).not.toContain(token);
      expect(text).toContain(`:${PORT}/mcp`);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  }, 60_000);

  // Perplexity Computer is a GUI connector (Settings → Connectors, Pro account):
  // there is no CLI to wire E2E. We can only assert `connect` prints the exact
  // values the user pastes into the GUI.
  test('perplexity print mode yields the GUI connector values (no CLI to wire E2E)', () => {
    expect(serverReady).toBe(true);
    const r = runConnectCli([MCP_URL, '--token', token, '--agent', 'perplexity'], {});
    expect(r.code).toBe(0);
    expect(r.out).toContain(`:${PORT}/mcp`);
    expect(r.out).toContain(token); // print mode shows the token to paste into the connector
    expect(r.out).toMatch(/Settings.+Connectors/);
  }, 30_000);

  // The OAuth path Perplexity actually uses, proven end-to-end against the live
  // server: register a client → connect --oauth formats it → mint a real
  // client-credentials access token via OAuth discovery + /token → call
  // get_brain_identity with that token. This exercises the whole chain a
  // Perplexity OAuth connector walks.
  test('perplexity OAuth: connect --oauth → mint client-credentials token → tool call', async () => {
    expect(serverReady).toBe(true);
    // The OAuth client was registered in beforeAll (before serve took the
    // PGLite write lock). Here: format it, then walk the connector's flow.
    // 1. `connect --oauth` formats the connector block with the right issuer.
    const conn = runConnectCli([MCP_URL, '--agent', 'perplexity', '--oauth', '--client-id', oauthClientId, '--client-secret', oauthClientSecret], {});
    expect(conn.code).toBe(0);
    expect(conn.out).toContain(`Issuer URL:    ${BASE}`);
    expect(conn.out).toContain(`Client ID:     ${oauthClientId}`);

    // 2. Mint a real access token the way a connector does, then call a tool.
    const disco = await discoverOAuth(BASE, { timeoutMs: 10_000 });
    expect(disco.ok).toBe(true);
    if (!disco.ok) return;
    const minted = await mintClientCredentialsToken(disco.metadata.token_endpoint, oauthClientId, oauthClientSecret, { scope: 'read write', timeoutMs: 10_000 });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const probed = await probeBrainIdentity(MCP_URL, minted.token.access_token, { timeoutMs: 15_000 });
    expect(probed.ok).toBe(true);
    if (probed.ok) expect(probed.identity).toMatch(/version/);
  }, 60_000);
});
