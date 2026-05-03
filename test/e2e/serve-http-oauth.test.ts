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

describeE2E('serve-http OAuth 2.1 E2E (v0.26.1)', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let clientId: string;
  let clientSecret: string;
  let adminToken: string;

  beforeAll(async () => {
    const { execSync, spawn } = await import('child_process');

    // Clean up orphans from any previous crashed test runs
    try {
      const postgres = (await import('postgres')).default;
      const cleanSql = postgres(process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '', { prepare: false });
      await cleanSql`DELETE FROM oauth_tokens WHERE client_id IN (SELECT client_id FROM oauth_clients WHERE client_name LIKE 'e2e-%')`;
      await cleanSql`DELETE FROM oauth_clients WHERE client_name LIKE 'e2e-%'`;
      await cleanSql`DELETE FROM access_tokens WHERE name LIKE 'e2e-%'`;
      await cleanSql.end();
    } catch {}

    // Register a test OAuth client via CLI
    const regOutput = execSync(
      'bun run src/cli.ts auth register-client e2e-oauth-test --grant-types client_credentials --scopes "read write"',
      { cwd: process.cwd(), encoding: 'utf8' }
    );
    const idMatch = regOutput.match(/Client ID:\s+(gbrain_cl_\S+)/);
    const secretMatch = regOutput.match(/Client Secret:\s+(gbrain_cs_\S+)/);
    if (!idMatch || !secretMatch) throw new Error('Failed to register test client:\n' + regOutput);
    clientId = idMatch[1];
    clientSecret = secretMatch[1];

    // Start the HTTP server
    serverProcess = spawn('bun', [
      'run', 'src/cli.ts', 'serve', '--http',
      '--port', String(PORT),
      '--public-url', `http://localhost:${PORT}`,
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Collect stderr for debugging failures + admin token extraction
    let stderr = '';
    serverProcess.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      // Extract admin token from startup banner
      const match = stderr.match(/Admin Token.*\n.*?([a-f0-9]{20,})\s/s);
      if (match) adminToken = match[1].replace(/[^a-f0-9]/g, '');
    });

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

    // Extract admin token (may span two lines in the banner)
    const tokenLines = stderr.match(/Admin Token.*\n.*?\n.*?([a-f0-9\s]+)\s*║/s);
    if (tokenLines) {
      // Token is split across two ║ lines, concatenate
      const allHex = stderr.match(/║\s+([a-f0-9]+)\s+║/g);
      if (allHex && allHex.length >= 2) {
        adminToken = allHex.slice(-2).map(l => l.replace(/[^a-f0-9]/g, '')).join('');
      }
    }
    if (!adminToken) throw new Error('Could not extract admin token from server output.\nstderr tail: ' + stderr.slice(-1000));
    console.log('[e2e] Admin token extracted:', adminToken.substring(0, 12) + '...');
  }, 30_000);

  afterAll(async () => {
    // Kill server
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    // Nuclear cleanup via direct SQL — CLI revoke is unreliable
    try {
      const postgres = (await import('postgres')).default;
      const sql = postgres(process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '', { prepare: false });
      await sql`DELETE FROM oauth_tokens WHERE client_id IN (SELECT client_id FROM oauth_clients WHERE client_name LIKE 'e2e-%')`;
      await sql`DELETE FROM mcp_request_log WHERE token_name IN (SELECT client_id FROM oauth_clients WHERE client_name LIKE 'e2e-%')`;
      await sql`DELETE FROM oauth_clients WHERE client_name LIKE 'e2e-%'`;
      await sql`DELETE FROM mcp_request_log WHERE agent_name LIKE 'e2e-%'`;
      await sql`DELETE FROM access_tokens WHERE name LIKE 'e2e-%'`;
      await sql.end();
    } catch (e) {
      console.error('[e2e] Cleanup failed:', e instanceof Error ? e.message : e);
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
    expect(data.page_count).toBeGreaterThan(0);
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
  // Revoke client
  // =========================================================================

  test('revoke client via admin API invalidates all tokens', async () => {
    // Register a disposable client
    const { execSync } = await import('child_process');
    const regOutput = execSync(
      'bun run src/cli.ts auth register-client e2e-revoke-test --grant-types client_credentials --scopes "read"',
      { cwd: process.cwd(), encoding: 'utf8' }
    );
    const id = regOutput.match(/Client ID:\s+(gbrain_cl_\S+)/)?.[1];
    const secret = regOutput.match(/Client Secret:\s+(gbrain_cs_\S+)/)?.[1];
    expect(id).toBeDefined();
    expect(secret).toBeDefined();

    // Mint a token — should work
    const tokenRes = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${id}&client_secret=${secret}&scope=read`,
    });
    expect(tokenRes.ok).toBe(true);
    const { access_token } = await tokenRes.json() as any;

    // Verify token works
    const before = await mcpCall(access_token, 'tools/list');
    expect(before.status).not.toBe(401);

    // Use the magic link to get a session cookie
    const authRes = await fetch(`${BASE}/admin/auth/${adminToken}`, { redirect: 'manual' });
    const cookie = authRes.headers.get('set-cookie') || '';

    const revokeRes = await fetch(`${BASE}/admin/api/revoke-client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
      body: JSON.stringify({ clientId: id }),
    });
    if (!revokeRes.ok) {
      const errBody = await revokeRes.text();
      throw new Error(`Revoke failed ${revokeRes.status}: ${errBody}\ncookie: ${cookie.substring(0, 30)}`);
    }
    const revokeData = await revokeRes.json() as any;
    expect(revokeData.revoked).toBe(true);

    // Token should no longer work
    const after = await mcpCall(access_token, 'tools/list');
    const afterBody = await after.text();
    expect(after.status >= 400 || afterBody.includes('invalid_token') || afterBody.includes('error')).toBe(true);

    // Minting new tokens should fail
    const mintAfter = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${id}&client_secret=${secret}&scope=read`,
    });
    expect(mintAfter.ok).toBe(false);
  }, 30_000);

  test('revoke API key via admin API', async () => {
    // Get admin session
    const authRes = await fetch(`${BASE}/admin/auth/${adminToken}`, { redirect: 'manual' });
    const cookie = authRes.headers.get('set-cookie') || '';

    // Create key
    const createRes = await fetch(`${BASE}/admin/api/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
      body: JSON.stringify({ name: 'e2e-revoke-key-test' }),
    });
    expect(createRes.ok).toBe(true);
    const { token } = await createRes.json() as any;
    expect(token).toBeDefined();

    // Token should work at /mcp
    const before = await mcpCall(token, 'tools/list');
    expect(before.status).not.toBe(401);

    // Revoke it
    const revokeRes = await fetch(`${BASE}/admin/api/api-keys/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
      body: JSON.stringify({ name: 'e2e-revoke-key-test' }),
    });
    expect(revokeRes.ok).toBe(true);

    // Token should no longer work
    const after = await mcpCall(token, 'tools/list');
    const afterBody = await after.text();
    expect(after.status >= 400 || afterBody.includes('invalid_token') || afterBody.includes('error')).toBe(true);
  }, 30_000);
});
