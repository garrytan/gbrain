/**
 * E2E tests for serve-http.ts OAuth 2.1 fixes (v0.26.1).
 *
 * Spins up a real `gbrain serve --http` against real Postgres, registers an
 * OAuth client, mints tokens, and exercises the full MCP JSON-RPC pipeline
 * end-to-end. Catches the three bugs fixed in v0.26.1:
 *
 *   1. client_credentials tokens rejected at /mcp (expiresAt string vs number)
 *   2. OAuth metadata missing client_credentials grant type
 *   3. Express 5 trust proxy + admin SPA wildcard
 *
 * Run: GBRAIN_DATABASE_URL=... bun test test/e2e/serve-http-oauth.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase } from './helpers.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E serve-http-oauth tests (DATABASE_URL not set)');
}

const PORT = 19131; // Avoid collision with production 3131
const BASE = `http://localhost:${PORT}`;

describeE2E('serve-http OAuth 2.1 E2E (v0.26.1 + v0.26.2)', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  // DCR-registered clients accumulate here so afterAll can revoke them too
  // (one per test that posts to /register).
  const dcrClientIds: string[] = [];

  beforeAll(async () => {
    const { execSync, spawn } = await import('child_process');

    // Register a test OAuth client via CLI.
    // env: { ...process.env } is required: bun's execSync does NOT inherit
    // env mutations done via `process.env.X = ...` (only OS-level env from
    // before bun started). helpers.ts loads .env.testing and sets DATABASE_URL
    // via process.env mutation, which is invisible to subprocesses unless we
    // explicitly re-pass process.env. Same pattern applies to every execSync
    // in this file.
    const regOutput = execSync(
      'bun run src/cli.ts auth register-client e2e-oauth-test --grant-types client_credentials --scopes "read write"',
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } }
    );
    const idMatch = regOutput.match(/Client ID:\s+(gbrain_cl_\S+)/);
    const secretMatch = regOutput.match(/Client Secret:\s+(gbrain_cs_\S+)/);
    if (!idMatch || !secretMatch) throw new Error('Failed to register test client:\n' + regOutput);
    clientId = idMatch[1];
    clientSecret = secretMatch[1];

    // Start the HTTP server. v0.26.2 adds --enable-dcr so the /register
    // endpoint is reachable for the DCR response-shape test.
    serverProcess = spawn('bun', [
      'run', 'src/cli.ts', 'serve', '--http',
      '--port', String(PORT),
      '--public-url', `http://localhost:${PORT}`,
      '--enable-dcr',
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Collect stderr for debugging failures
    let stderr = '';
    serverProcess.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    // Wait for server to be ready (up to 15s)
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) { ready = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) throw new Error('Server failed to start within 15s.\nstderr: ' + stderr.slice(-500));
  }, 30_000);

  afterAll(async () => {
    // Kill server first so it can't issue more tokens during cleanup.
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    // v0.26.2 cleanup contract: only revoke if registration succeeded
    // (clientId guard) and surface any cleanup failure to stderr without
    // throwing — a real test failure is more interesting than the cleanup
    // error that follows it. Same shape applies to DCR-registered clients
    // tracked in dcrClientIds.
    const { execSync } = await import('child_process');
    const toRevoke = [...(clientId ? [clientId] : []), ...dcrClientIds];
    for (const id of toRevoke) {
      try {
        execSync(`bun run src/cli.ts auth revoke-client "${id}"`,
          { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } });
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error(`[afterAll] revoke-client cleanup failed for ${id}: ${e.message}`);
      }
    }
  });

  // Helper: mint a token with given scopes
  async function mintToken(scope = 'read write'): Promise<{ access_token: string; expires_in: number; scope: string }> {
    const res = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}&scope=${encodeURIComponent(scope)}`,
    });
    expect(res.ok).toBe(true);
    return res.json() as any;
  }

  // Helper: call MCP JSON-RPC with a bearer token
  async function mcpCall(token: string, method: string, params?: any): Promise<Response> {
    return fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
    });
  }

  // =========================================================================
  // Fix 1: client_credentials tokens validate at /mcp
  // =========================================================================

  test('mint token via client_credentials grant', async () => {
    const data = await mintToken('read write');
    expect(data.access_token).toMatch(/^gbrain_at_/);
    expect(data.expires_in).toBe(3600);
    expect(data.scope).toContain('read');
  });

  test('minted token is accepted at /mcp — tools/list returns tools', async () => {
    const { access_token } = await mintToken('read');
    const res = await mcpCall(access_token, 'tools/list');

    // Before v0.26.1 fix: 401 {"error":"invalid_token","error_description":"Token has no expiration time"}
    expect(res.status).not.toBe(401);

    const body = await res.text();
    expect(body).toContain('tools');
    expect(body).toContain('search'); // search tool should be in the list
    expect(body).toContain('query');  // query tool too
  }, 15_000);

  test('minted token works for tools/call — search executes', async () => {
    const { access_token } = await mintToken('read');
    const res = await mcpCall(access_token, 'tools/call', {
      name: 'search',
      arguments: { query: 'gbrain', limit: 1 },
    });

    expect(res.status).not.toBe(401);
    const body = await res.text();
    // Should contain search results, not an auth error
    expect(body).not.toContain('invalid_token');
    expect(body).toContain('result');
  }, 15_000);

  test('expired/invalid token is rejected at /mcp', async () => {
    const res = await mcpCall('gbrain_at_totally_fake_token', 'tools/list');
    // Invalid tokens should not return 200 with tool results
    const body = await res.text();
    expect(body).not.toContain('"tools"');
    // Should be an error status (401, 403, or 500 depending on SDK error mapping)
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('missing Authorization header returns 401', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  // =========================================================================
  // Fix 2: OAuth metadata includes client_credentials
  // =========================================================================

  test('OAuth AS metadata includes all three grant types', async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(res.ok).toBe(true);
    const meta = await res.json() as any;
    expect(meta.grant_types_supported).toContain('authorization_code');
    expect(meta.grant_types_supported).toContain('refresh_token');
    expect(meta.grant_types_supported).toContain('client_credentials');
  });

  test('OAuth metadata issuer matches public URL', async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    const meta = await res.json() as any;
    expect(meta.issuer).toBe(`http://localhost:${PORT}/`);
    expect(meta.token_endpoint).toContain('/token');
    expect(meta.scopes_supported).toContain('read');
    expect(meta.scopes_supported).toContain('write');
    expect(meta.scopes_supported).toContain('admin');
  });

  // =========================================================================
  // Fix 3: Express 5 compatibility
  // =========================================================================

  test('admin dashboard serves SPA index.html (not Express error)', async () => {
    const res = await fetch(`${BASE}/admin/`);
    const html = await res.text();
    expect(html).toContain('GBrain Admin');
    expect(html).not.toContain('<pre>Cannot GET');
  });

  test('admin sub-routes serve SPA fallback', async () => {
    const res = await fetch(`${BASE}/admin/agents`);
    const html = await res.text();
    expect(html).toContain('GBrain Admin');
  });

  test('X-Forwarded-For header does not crash server', async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { 'X-Forwarded-For': '10.0.0.1, 172.16.0.1' },
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.status).toBe('ok');
  });

  // =========================================================================
  // Scope enforcement
  // =========================================================================

  test('read-only token is rejected for write operations', async () => {
    const { access_token } = await mintToken('read');
    const res = await mcpCall(access_token, 'tools/call', {
      name: 'put_page',
      arguments: { slug: 'e2e-scope-test', content: '---\ntitle: test\n---\ntest' },
    });

    const body = await res.text();
    // Should be rejected via scope check (403 or JSON-RPC error with scope message)
    expect(res.status === 403 || body.includes('scope') || body.includes('Insufficient')).toBe(true);
  }, 15_000);

  test('write-scoped token can call read operations', async () => {
    const { access_token } = await mintToken('read write');
    const res = await mcpCall(access_token, 'tools/call', {
      name: 'search',
      arguments: { query: 'test', limit: 1 },
    });

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    const body = await res.text();
    // Should get a result, not an auth error
    expect(body).not.toContain('invalid_token');
    expect(body).not.toContain('insufficient_scope');
  }, 15_000);

  // =========================================================================
  // Health endpoint (no auth required)
  // =========================================================================

  test('health endpoint returns OK without auth', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.status).toBe('ok');
    expect(data.version).toBeDefined();
    // page_count: the endpoint must return a non-negative integer. The exact
    // value depends on the deployment's brain state and is not what this test
    // is checking — pre-v0.26.2 this asserted `> 0` and broke on fresh schemas.
    expect(typeof data.page_count).toBe('number');
    expect(data.page_count).toBeGreaterThanOrEqual(0);
  });

  // =========================================================================
  // Token lifecycle
  // =========================================================================

  test('multiple tokens can be minted and used independently', async () => {
    const t1 = await mintToken('read');
    const t2 = await mintToken('read write');

    // Both should work
    const r1 = await mcpCall(t1.access_token, 'tools/list');
    const r2 = await mcpCall(t2.access_token, 'tools/list');

    expect(r1.status).not.toBe(401);
    expect(r2.status).not.toBe(401);
  }, 15_000);

  test('wrong client_secret is rejected at token endpoint', async () => {
    const res = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=gbrain_cs_wrong_secret&scope=read`,
    });
    expect(res.ok).toBe(false);
    const data = await res.json() as any;
    expect(data.error).toBe('invalid_grant');
  });

  // =========================================================================
  // v0.26.2: DCR /register response shape (RFC 7591 §3.2.1 number contract)
  // =========================================================================
  //
  // The user-visible bug v0.26.2 protects against: postgres.js with
  // `prepare: false` returns BIGINT columns as strings, and an RFC-strict
  // DCR client (Claude Code, Cursor) parses the /register response as JSON
  // and rejects timestamps that aren't numbers. This is the HTTP-level test;
  // the internal-store shape test in test/oauth.test.ts is not enough on its
  // own (Codex flagged it as the wrong seam).

  test('DCR /register returns numeric client_id_issued_at (RFC 7591 §3.2.1)', async () => {
    const res = await fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'e2e-dcr-shape',
        redirect_uris: ['https://example.com/cb'],
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'client_secret_basic',
        scope: 'read',
      }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;

    // Track for cleanup before any assertion that could throw.
    if (body.client_id) dcrClientIds.push(body.client_id);

    // The contract: client_id_issued_at is REQUIRED to be a JSON number per
    // RFC 7591. Pre-v0.26.2 with prepare:false returned this as a string
    // (e.g., "1735689600") and strict clients rejected the registration.
    expect(typeof body.client_id_issued_at).toBe('number');
    expect(Number.isFinite(body.client_id_issued_at)).toBe(true);
    expect(body.client_id_issued_at).toBeGreaterThan(0);

    // client_secret_expires_at is OPTIONAL. If present, it must also be a
    // number. Undefined/missing means "does not expire" per the spec.
    if (body.client_secret_expires_at !== undefined) {
      expect(typeof body.client_secret_expires_at).toBe('number');
      expect(Number.isFinite(body.client_secret_expires_at)).toBe(true);
    }
  }, 15_000);

  // =========================================================================
  // v0.26.2: revoke-client CLI subprocess test
  // =========================================================================
  //
  // Validates the actual CLI router in src/commands/auth.ts, not just the
  // database deletion semantics. Codex flagged that a unit test in
  // test/oauth.test.ts proves DB DELETE works but does NOT prove the
  // subcommand exists or routes correctly.

  test('auth revoke-client (CLI) deletes client + cascades to tokens', async () => {
    const { execSync } = await import('child_process');

    // Step 1: register a throwaway client via CLI.
    // env: { ...process.env } per the bun execSync inheritance fix above.
    const regOutput = execSync(
      'bun run src/cli.ts auth register-client e2e-revoke-cli --grant-types client_credentials --scopes read',
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } }
    );
    const idMatch = regOutput.match(/Client ID:\s+(gbrain_cl_\S+)/);
    const secretMatch = regOutput.match(/Client Secret:\s+(gbrain_cs_\S+)/);
    expect(idMatch).not.toBeNull();
    expect(secretMatch).not.toBeNull();
    const id = idMatch![1];
    const secret = secretMatch![1];

    // Step 2: mint a token through the live server.
    const tokenRes = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${id}&client_secret=${secret}&scope=read`,
    });
    expect(tokenRes.ok).toBe(true);
    const { access_token } = await tokenRes.json() as any;

    // Sanity: the freshly-minted token works at /mcp.
    const before = await mcpCall(access_token, 'tools/list');
    expect(before.status).not.toBe(401);

    // Step 3: revoke via the CLI subprocess.
    const revokeOutput = execSync(
      `bun run src/cli.ts auth revoke-client "${id}"`,
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } }
    );
    // The handler prints the human confirmation lines. No exit code != 0
    // here since execSync would throw.
    expect(revokeOutput).toMatch(/OAuth client revoked/);
    expect(revokeOutput).toMatch(/cascade/i);

    // Step 4: previously-minted token must now be rejected at /mcp. Cascade
    // wiped the oauth_tokens row; verifyAccessToken throws "Invalid token".
    // Match the existing pattern at line 156: SDK error mapping varies
    // (401/403/500), so we assert non-success status + non-success body
    // rather than a single status code.
    const after = await mcpCall(access_token, 'tools/list');
    expect(after.status).toBeGreaterThanOrEqual(400);
    const afterBody = await after.text();
    expect(afterBody).not.toContain('"tools":[');

    // Step 5: re-running revoke-client on the now-deleted id must exit 1.
    let secondRunFailed = false;
    let secondRunStderr = '';
    try {
      execSync(`bun run src/cli.ts auth revoke-client "${id}"`,
        { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } });
    } catch (e: any) {
      secondRunFailed = true;
      secondRunStderr = (e.stderr || '').toString() + (e.stdout || '').toString();
    }
    expect(secondRunFailed).toBe(true);
    expect(secondRunStderr).toMatch(/No client found/);
  }, 30_000);
});
