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
import { createHash } from 'crypto';
import { hasDatabase } from './helpers.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const skip = !hasDatabase();
// #3485 name floor: this suite opens raw postgres() clients on the ambient URL
// and runs DROP TRIGGER/FUNCTION + DELETE cleanups — refuse non-test-shaped
// database names before any connection is made.
if (!skip) {
  assertSafeE2eDatabaseUrl(process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '');
}
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E serve-http-oauth tests (DATABASE_URL not set)');
}

const PORT = 19131; // Avoid collision with production 3131
const BASE = `http://localhost:${PORT}`;
const ADMIN_BOOTSTRAP_TOKEN = 'e2e-admin-bootstrap-token-000000000000';

describeE2E('serve-http OAuth 2.1 E2E (v0.26.1 + v0.26.2 + v0.26.3)', () => {
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
    // v0.28.10: register with admin scope so the F7 protected-name guard
    // tests can mint admin-scoped tokens that actually exercise the guard
    // at operations.ts:1527. Without admin in the client's allowed scopes,
    // submit_job for a protected name (`shell`, `subagent`) gets rejected
    // by hasScope() in serve-http.ts BEFORE reaching the F7 guard, so the
    // test was validating scope enforcement instead of the RCE protection.
    // Other tests that mint specific subsets ('read', 'read write') still
    // get the subset they ask for — adding admin to the client's allowed
    // ceiling does not auto-grant it to every minted token.
    const regOutput = execSync(
      'bun run src/cli.ts auth register-client e2e-oauth-test --grant-types client_credentials --scopes "read write admin"',
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
      env: { ...process.env, GBRAIN_ADMIN_BOOTSTRAP_TOKEN: ADMIN_BOOTSTRAP_TOKEN },
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
  }, 30_000);

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

  async function adminCookie(): Promise<string> {
    const login = await fetch(`${BASE}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ADMIN_BOOTSTRAP_TOKEN }),
    });
    expect(login.ok).toBe(true);
    const match = (login.headers.get('set-cookie') || '').match(/gbrain_admin=([^;]+)/);
    expect(match).toBeTruthy();
    return `gbrain_admin=${match![1]}`;
  }

  // ── C4/C5/C6 helpers ──────────────────────────────────────────────────

  // /mcp responses arrive either as plain JSON or as an SSE stream
  // (`event: message\ndata: {...}`) depending on the SDK transport's
  // negotiated response mode. Extract the JSON-RPC envelope either way.
  function parseJsonRpc(text: string): any {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
    const dataLines = trimmed.split('\n').filter(l => l.startsWith('data:'));
    if (dataLines.length === 0) {
      throw new Error('No JSON-RPC payload in /mcp response: ' + trimmed.slice(0, 200));
    }
    return JSON.parse(dataLines[dataLines.length - 1].slice('data:'.length).trim());
  }

  // tools/call + tools/list wrapper that unwraps the JSON-RPC result.
  // Scope denials are TOOL results (200 + isError:true envelope), never
  // transport-level errors, so a non-200 here is always a test failure.
  async function mcpToolResult(token: string, method: string, params?: any): Promise<any> {
    const res = await mcpCall(token, method, params);
    expect(res.status).toBe(200);
    const rpc = parseJsonRpc(await res.text());
    expect(rpc.error).toBeUndefined();
    return rpc.result;
  }

  // Mint a token for an arbitrary client (mintToken above is pinned to the
  // fixture client).
  async function mintFor(id: string, secret: string, scope: string): Promise<string> {
    const res = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${id}&client_secret=${secret}&scope=${encodeURIComponent(scope)}`,
    });
    expect(res.ok).toBe(true);
    return ((await res.json()) as any).access_token;
  }

  async function registerThrowawayClient(name: string, scopes: string): Promise<{ id: string; secret: string }> {
    const { execSync } = await import('child_process');
    const reg = execSync(
      `bun run src/cli.ts auth register-client ${name} --grant-types client_credentials --scopes "${scopes}"`,
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } },
    );
    const id = reg.match(/Client ID:\s+(gbrain_cl_\S+)/)?.[1];
    const secret = reg.match(/Client Secret:\s+(gbrain_cs_\S+)/)?.[1];
    if (!id || !secret) throw new Error(`Failed to register ${name}:\n` + reg);
    dcrClientIds.push(id); // afterAll cleanup
    return { id, secret };
  }

  // Dedicated read+write client for C4/C5 so mcp_request_log assertions are
  // isolated from the shared fixture client's rows. Registered lazily once.
  let c45Client: { id: string; secret: string } | undefined;
  async function ensureC45Client(): Promise<{ id: string; secret: string }> {
    if (!c45Client) {
      c45Client = await registerThrowawayClient(`e2e-c45-scope-${Date.now()}`, 'read write');
    }
    return c45Client;
  }

  async function withSql<T>(fn: (sql: any) => Promise<T>): Promise<T> {
    const postgres = (await import('postgres')).default;
    const sql = postgres(process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '', { prepare: false });
    try {
      return await fn(sql);
    } finally {
      await sql.end();
    }
  }

  // The request-log INSERT is awaited server-side but best-effort; poll so a
  // slow commit never flakes the assertion. Returns the rows (oldest first)
  // once `ready` is satisfied, or the last observed rows after ~3s.
  async function pollLogRows(
    sql: any,
    tokenName: string,
    ready: (rows: Array<Record<string, unknown>>) => boolean,
  ): Promise<Array<Record<string, unknown>>> {
    let rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 20; i++) {
      rows = await sql`
        SELECT id, operation, status, error_message, params->>'tool_count' AS tool_count
        FROM mcp_request_log
        WHERE token_name = ${tokenName}
        ORDER BY id ASC
      ` as unknown as Array<Record<string, unknown>>;
      if (ready(rows)) return rows;
      await new Promise(r => setTimeout(r, 150));
    }
    return rows;
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
    expect(meta.token_endpoint_auth_methods_supported).toEqual(
      expect.arrayContaining(['client_secret_post', 'client_secret_basic', 'none']),
    );
    expect(meta.revocation_endpoint_auth_methods_supported).toEqual(
      expect.arrayContaining(['client_secret_post', 'client_secret_basic']),
    );
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

  // T2 (eng-review): scopes_supported advertises the full ALLOWED_SCOPES_LIST
  // so MCP clients (Claude Desktop, ChatGPT, Perplexity) can discover the
  // v0.28 sources_admin and users_admin scopes via standard discovery.
  // Pre-v0.28 the list was hardcoded to ['read','write','admin'] in
  // serve-http.ts:195 and this assertion would have failed.
  test('OAuth metadata advertises all 5 v0.28 scopes (sources_admin + users_admin)', async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    const meta = await res.json() as any;
    expect(meta.scopes_supported).toContain('sources_admin');
    expect(meta.scopes_supported).toContain('users_admin');
    expect(meta.scopes_supported).toEqual(
      expect.arrayContaining(['admin', 'read', 'sources_admin', 'users_admin', 'write']),
    );
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

  test('admin source access APIs enumerate sources and rescope an OAuth client', async () => {
    const cookie = await adminCookie();
    const sourcesRes = await fetch(`${BASE}/admin/api/sources`, {
      headers: { Cookie: cookie },
    });
    expect(sourcesRes.ok).toBe(true);
    const sources = await sourcesRes.json() as Array<{ id: string; name: string; federated: boolean }>;
    expect(sources.some(source => source.id === 'default')).toBe(true);

    const rescopeRes = await fetch(`${BASE}/admin/api/rescope-client`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        sourceId: 'default',
        federatedRead: ['default'],
      }),
    });
    expect(rescopeRes.ok).toBe(true);
    expect(await rescopeRes.json()).toEqual({
      clientId,
      clientName: 'e2e-oauth-test',
      sourceId: 'default',
      federatedRead: ['default'],
    });

    const agentsRes = await fetch(`${BASE}/admin/api/agents`, {
      headers: { Cookie: cookie },
    });
    expect(agentsRes.ok).toBe(true);
    const agents = await agentsRes.json() as Array<{
      id: string;
      source_id: string | null;
      federated_read: string[];
    }>;
    const agent = agents.find(row => row.id === clientId);
    expect(agent?.source_id).toBe('default');
    expect(agent?.federated_read).toEqual(['default']);
  }, 15_000);

  // v0.36.1.x #1076: GET /mcp must return 405 (Method Not Allowed) per the
  // MCP Streamable HTTP spec, not 404. claude.ai + other probing clients
  // distinguish "endpoint exists, no SSE channel" from "endpoint missing"
  // on this status code; 404 makes them give up.
  test('GET /mcp returns 405 with Allow: POST, DELETE (v0.36.1.x #1076)', async () => {
    const res = await fetch(`${BASE}/mcp`, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST, DELETE');
    const body = await res.json() as { jsonrpc?: string; error?: { code?: number } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error?.code).toBe(-32000);
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
  // Health endpoint (no auth required) — v0.28.10 made /health liveness-only;
  // engine stats moved to /admin/api/full-stats behind requireAdmin so a
  // saturated pool can't pin /health and trigger orchestrator restart cascades.
  // =========================================================================

  test('v0.28.10: /health returns liveness-only body (no engine stats)', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.status).toBe('ok');
    expect(data.version).toBeDefined();
    expect(data.engine).toBeDefined();
    // Regression: pre-v0.28.10 /health spread getStats() (page_count,
    // chunk_count, etc.) into the body. The whole point of the v0.28.10
    // split is that /health stops touching those tables. If page_count
    // ever reappears here, the heavy probe leaked back into the public
    // route and the original DoS surface is back.
    expect(data.page_count).toBeUndefined();
    expect(data.chunk_count).toBeUndefined();
    expect(data.embedded_count).toBeUndefined();
    // Body shape is exactly {status, version, engine}.
    expect(Object.keys(data).sort()).toEqual(['engine', 'status', 'version']);
  });

  test('v0.28.10: /admin/api/full-stats without admin cookie returns 401', async () => {
    const res = await fetch(`${BASE}/admin/api/full-stats`);
    expect(res.status).toBe(401);
    const data = await res.json() as any;
    expect(data.error).toBe('Admin authentication required');
  });

  test('v0.28.10: /admin/api/full-stats with valid admin cookie returns getStats() body', async () => {
    const cookie = await adminCookie();

    const statsRes = await fetch(`${BASE}/admin/api/full-stats`, {
      headers: { Cookie: cookie },
    });
    expect(statsRes.ok).toBe(true);
    const stats = await statsRes.json() as any;
    expect(stats.status).toBe('ok');
    expect(stats.version).toBeDefined();
    expect(stats.engine).toBeDefined();
    // The full-stats body is probeHealth's spread of getStats() — page_count
    // is the canonical signal that we're hitting the heavy path here.
    expect(typeof stats.page_count).toBe('number');
    expect(stats.page_count).toBeGreaterThanOrEqual(0);
  }, 15_000);

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

  test('confidential client can revoke its token only with its valid secret', async () => {
    const { access_token } = await mintToken('read');
    const wrongSecret = await fetch(`${BASE}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(access_token)}&client_id=${clientId}&client_secret=gbrain_cs_wrong_secret`,
    });
    expect(wrongSecret.status).toBe(401);
    expect((await wrongSecret.json() as any).error).toBe('invalid_client');

    // A rejected revoke request must leave the token usable.
    expect((await mcpCall(access_token, 'tools/list')).status).toBe(200);

    const revoke = await fetch(`${BASE}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(access_token)}&client_id=${clientId}&client_secret=${clientSecret}`,
    });
    expect(revoke.status).toBe(200);
    expect(revoke.headers.get('cache-control')).toBe('no-store');
    expect((await mcpCall(access_token, 'tools/list')).status).toBe(401);
  }, 15_000);

  test('confidential client_secret_basic revoke returns canonical auth responses', async () => {
    const { access_token: wrongSecretToken } = await mintToken('read');
    const wrongBasic = Buffer.from(`${encodeURIComponent(clientId!)}:${encodeURIComponent('wrong-secret')}`).toString('base64');
    const rejected = await fetch(`${BASE}/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${wrongBasic}`,
      },
      body: `token=${encodeURIComponent(wrongSecretToken)}`,
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get('www-authenticate')).toMatch(/^Basic /);
    expect((await mcpCall(wrongSecretToken, 'tools/list')).status).toBe(200);

    const { access_token } = await mintToken('read');
    const validBasic = Buffer.from(`${encodeURIComponent(clientId!)}:${encodeURIComponent(clientSecret!)}`).toString('base64');
    const revoked = await fetch(`${BASE}/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${validBasic}`,
      },
      body: `token=${encodeURIComponent(access_token)}`,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get('cache-control')).toBe('no-store');
    expect((await mcpCall(access_token, 'tools/list')).status).toBe(401);
  }, 15_000);

  test('revoke validates request shape and rejects mixed client authentication', async () => {
    const { access_token } = await mintToken('read');
    const validBasic = Buffer.from(`${encodeURIComponent(clientId!)}:${encodeURIComponent(clientSecret!)}`).toString('base64');

    const mixed = await fetch(`${BASE}/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${validBasic}`,
      },
      body: `token=${encodeURIComponent(access_token)}&client_id=${clientId}&client_secret=${clientSecret}`,
    });
    expect(mixed.status).toBe(400);
    expect((await mixed.json() as any).error).toBe('invalid_request');

    const repeatedToken = await fetch(`${BASE}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(access_token)}&token=duplicate&client_id=${clientId}&client_secret=${clientSecret}`,
    });
    expect(repeatedToken.status).toBe(400);
    expect((await repeatedToken.json() as any).error).toBe('invalid_request');

    const missingToken = await fetch(`${BASE}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${clientId}&client_secret=${clientSecret}`,
    });
    expect(missingToken.status).toBe(400);
    expect((await missingToken.json() as any).error).toBe('invalid_request');
    expect((await mcpCall(access_token, 'tools/list')).status).toBe(200);
  }, 15_000);

  test('unknown and cross-client tokens are opaque 200 no-ops', async () => {
    const unknown = await fetch(`${BASE}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=unknown-token&client_id=${clientId}&client_secret=${clientSecret}`,
    });
    expect(unknown.status).toBe(200);

    const { execSync } = await import('child_process');
    const attackerRegistration = execSync(
      `bun run src/cli.ts auth register-client e2e-revoke-attacker-${Date.now()} --grant-types client_credentials --scopes read`,
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } },
    );
    const attackerId = attackerRegistration.match(/Client ID:\s+(gbrain_cl_\S+)/)?.[1];
    const attackerSecret = attackerRegistration.match(/Client Secret:\s+(gbrain_cs_\S+)/)?.[1];
    expect(attackerId).toBeTruthy();
    expect(attackerSecret).toBeTruthy();
    dcrClientIds.push(attackerId!);

    const { access_token: ownerToken } = await mintToken('read');
    const crossClient = await fetch(`${BASE}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(ownerToken)}&client_id=${attackerId}&client_secret=${attackerSecret}`,
    });
    expect(crossClient.status).toBe(200);
    expect((await mcpCall(ownerToken, 'tools/list')).status).toBe(200);
  }, 30_000);

  test('public client revoke falls through to the SDK handler', async () => {
    const { execSync } = await import('child_process');
    const registration = execSync(
      `bun run src/cli.ts auth register-client e2e-revoke-public-${Date.now()} --grant-types authorization_code --scopes read --token-endpoint-auth-method none`,
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } },
    );
    const publicClientId = registration.match(/Client ID:\s+(gbrain_cl_\S+)/)?.[1];
    expect(publicClientId).toBeTruthy();
    dcrClientIds.push(publicClientId!);

    const publicToken = `gbrain_at_public_${Date.now()}`;
    const tokenHash = createHash('sha256').update(publicToken).digest('hex');
    const postgres = (await import('postgres')).default;
    const sql = postgres(process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '', { prepare: false });
    try {
      // Plain-array bind, NOT `sql.array([...])`: sql.array resolves its
      // array OID (and serializer) through postgres.js's typeArrayMap, which
      // is fetched asynchronously on connection startup. This INSERT is the
      // FIRST query on this fresh connection, so the map is still empty and
      // sql.array falls back to the element OID (25 = text) with scalar
      // serialization — real Postgres rejects it with 42804 ("column scopes
      // is of type text[] but expression is of type text"; an explicit
      // ::text[] cast just shifts the failure to 22P02 "malformed array
      // literal" because the value still serializes as a bare scalar). A
      // plain JS array always serializes to the `{...}` literal and binds
      // with an unspecified OID, so Postgres coerces it from column context
      // deterministically — same untyped-bind approach as pgArray() in
      // src/core/oauth-provider.ts. Latent since d61808d80 (v0.42.64.0):
      // CI's e2e.yml never runs this file.
      await sql`
        INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at)
        VALUES (${tokenHash}, ${'access'}, ${publicClientId!}, ${['read']}, ${Math.floor(Date.now() / 1000) + 3600})
      `;
    } finally {
      await sql.end();
    }

    expect((await mcpCall(publicToken, 'tools/list')).status).toBe(200);
    const revoked = await fetch(`${BASE}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(publicToken)}&client_id=${publicClientId}`,
    });
    expect(revoked.status).toBe(200);
    expect((await mcpCall(publicToken, 'tools/list')).status).toBe(401);
  }, 30_000);

  test('retryable revoke backend failure returns 503 and leaves token usable', async () => {
    const { access_token } = await mintToken('read');
    const tokenHash = createHash('sha256').update(access_token).digest('hex');
    const suffix = Date.now().toString();
    const functionName = `e2e_fail_revoke_${suffix}`;
    const triggerName = `e2e_fail_revoke_trigger_${suffix}`;
    const postgres = (await import('postgres')).default;
    const sql = postgres(process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '', { prepare: false });
    try {
      await sql.unsafe(`
        CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.token_hash = '${tokenHash}' THEN
            RAISE EXCEPTION 'injected retryable revoke failure' USING ERRCODE = '08006';
          END IF;
          RETURN OLD;
        END;
        $$
      `);
      await sql.unsafe(`
        CREATE TRIGGER ${triggerName}
        BEFORE DELETE ON oauth_tokens
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()
      `);

      const failed = await fetch(`${BASE}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(access_token)}&client_id=${clientId}&client_secret=${clientSecret}`,
      });
      expect(failed.status).toBe(503);
      expect((await failed.json() as any).error).toBe('temporarily_unavailable');
      expect((await mcpCall(access_token, 'tools/list')).status).toBe(200);
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON oauth_tokens`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
      await sql.end();
    }
  }, 30_000);

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
  // #2179: DCR token_ttl_seconds — wire-level clamp + echo
  // =========================================================================
  //
  // The unit tests in test/oauth-dcr-ttl.test.ts prove the store-level clamp;
  // this is the HTTP seam: the MCP SDK's /register handler STRIPS unknown
  // body members, so the field only works if serve-http's middleware carries
  // it through dcrRegistrationContext. With the clamp window unset, the max
  // derives fail-closed from the server's --token-ttl (default 3600) — a
  // huge request must come back clamped to that, not rejected — and the
  // minted token must match.

  test('DCR /register accepts token_ttl_seconds, clamps to policy, echoes effective value (#2179)', async () => {
    const res = await fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'e2e-dcr-ttl',
        redirect_uris: ['https://example.com/cb'],
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'client_secret_basic',
        scope: 'read',
        token_ttl_seconds: 365 * 24 * 3600, // way above any sane max
      }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    if (body.client_id) dcrClientIds.push(body.client_id);

    // Echoed effective value = clamped fail-closed to the server's
    // --token-ttl (3600, the default — the e2e server sets no flag and no
    // oauth.dcr_ttl_max_seconds config).
    expect(body.token_ttl_seconds).toBe(3600);

    // And a client that omits the field gets no echo (backward compatible).
    const res2 = await fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'e2e-dcr-no-ttl',
        redirect_uris: ['https://example.com/cb'],
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'client_secret_basic',
        scope: 'read',
      }),
    });
    expect(res2.ok).toBe(true);
    const body2 = await res2.json() as any;
    if (body2.client_id) dcrClientIds.push(body2.client_id);
    expect(body2.token_ttl_seconds).toBeUndefined();
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

  // =========================================================================
  // v0.26.3: Migration v33 round-trip — pins the 5 new columns
  // =========================================================================
  //
  // PR #586 referenced oauth_clients.{token_ttl, deleted_at} +
  // mcp_request_log.{agent_name, params, error_message} without an
  // accompanying migration. v33 adds them. This test pins the round-trip:
  // make a /mcp call -> assert all three new mcp_request_log columns
  // persisted correctly. Without v33, the INSERT silently swallows
  // column-doesn't-exist errors via the existing best-effort try/catch
  // and the row never appears.

  test('v0.26.3: /mcp request persists agent_name + params + error_message', async () => {
    const postgres = (await import('postgres')).default;
    const sql = postgres(process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '', { prepare: false });
    try {
      // Wipe any prior log rows for our test client so we can assert exact counts.
      await sql`DELETE FROM mcp_request_log WHERE token_name = ${clientId!}`;

      // Mint a fresh write-scoped token and make a successful tools/list call.
      const tokenRes = await fetch(`${BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${clientId!}&client_secret=${clientSecret!}&scope=read`,
      });
      expect(tokenRes.ok).toBe(true);
      const { access_token } = await tokenRes.json() as any;
      const okRes = await mcpCall(access_token, 'tools/list');
      expect(okRes.status).not.toBe(401);

      // Trigger an error path so the error_message column gets a value too.
      // Request a tool that doesn't exist — v0.28.10 logs unknown-op attempts
      // with operation = the attempted name and error_message starting with
      // 'unknown_operation:'.
      await mcpCall(access_token, 'tools/call', { name: 'this_tool_does_not_exist', arguments: {} });

      // Allow async best-effort INSERT to flush.
      await new Promise(r => setTimeout(r, 250));

      const rows = await sql`
        SELECT operation, status, agent_name, params, error_message
        FROM mcp_request_log
        WHERE token_name = ${clientId!}
        ORDER BY created_at ASC
      ` as unknown as Array<Record<string, unknown>>;

      expect(rows.length).toBeGreaterThanOrEqual(2);

      // Agent name resolved from oauth_clients.client_name (the JOIN in
      // verifyAccessToken or the agent_name backfill path).
      for (const row of rows) {
        expect(row.agent_name).toBe('e2e-oauth-test');
      }

      // v0.28.10: tools/list logs as operation='tools/list' (the JSON-RPC
      // method name). tools/call success/error logs as operation=<inner
      // tool name> (the convention preserved from pre-v0.28.10 dispatch
      // logging — agents querying mcp_request_log filter by tool name, not
      // by JSON-RPC method).
      const listRow = rows.find(r => r.operation === 'tools/list');
      expect(listRow).toBeDefined();
      expect(listRow!.status).toBe('success');

      // The unknown-op call shows up with operation = the attempted name.
      const callRow = rows.find(r => r.operation === 'this_tool_does_not_exist');
      expect(callRow).toBeDefined();
      expect(callRow!.status).toBe('error');

      // error_message populated on the failed call.
      const errorRow = rows.find(r => r.status === 'error');
      expect(errorRow).toBeDefined();
      expect(errorRow!.error_message).toBeTruthy();
      expect(typeof errorRow!.error_message).toBe('string');
      expect(errorRow!.error_message as string).toContain('unknown_operation');
    } finally {
      await sql.end();
    }
  }, 30_000);

  // =========================================================================
  // v0.26.3: request-log filter injection probe
  // =========================================================================
  //
  // Pre-fix: /admin/api/requests built WHERE clauses via sql.unsafe() with
  // single-quote escape (`token_name = '${agent.replace(/'/g, "''")}'`).
  // Post-fix: postgres.js tagged-template fragments. This probe sends a
  // payload that, under broken escaping, would short-circuit to TRUE and
  // return all rows. Under correct parameterization, it matches no rows.

  test("v0.26.3: request-log filter rejects injection attempt (' OR 1=1)", async () => {
    // Use a plain admin session via /admin/login + bootstrap token. This
    // test covers the unauthenticated SQL-injection vector via the agent
    // query parameter — even though the endpoint is admin-gated, defense-
    // in-depth on parameterization matters.
    //
    // Extract the admin bootstrap token from the spawned server's stderr.
    const probe = "alice'%20OR%201%3D1";

    // We don't have a clean way to pull the admin token from the spawned
    // process here (commit 16 deleted the regex extraction). The injection
    // probe still works WITHOUT auth — the endpoint requires it via 401.
    // We assert that the 401 lands BEFORE any SQL gets built, so we don't
    // crash the server with malformed SQL on the way to the auth check.
    const res = await fetch(`${BASE}/admin/api/requests?agent=${probe}`, {
      method: 'GET',
    });
    // No admin cookie — must hit 401, not 500 (no SQL crash).
    expect(res.status).toBe(401);

    // Server is still alive (didn't crash on the malformed input).
    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
  });

  // =========================================================================
  // v0.26.3: per-client TTL flow
  // =========================================================================
  //
  // PR #586 added `tokenTtl` per OAuth client. exchangeClientCredentials
  // reads oauth_clients.token_ttl (per-client override) and falls back to
  // the server default. This test registers a client with a custom TTL,
  // mints a token, and asserts the response's expires_in matches.

  test('v0.26.3: per-client token_ttl is honored on token mint', async () => {
    const postgres = (await import('postgres')).default;
    const sql = postgres(process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '', { prepare: false });
    try {
      // Register a client + set a custom token_ttl (24 hours = 86400 seconds).
      const { execSync } = await import('child_process');
      const regOutput = execSync(
        'bun run src/cli.ts auth register-client e2e-test-ttl --grant-types client_credentials --scopes read',
        { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } }
      );
      const idMatch = regOutput.match(/Client ID:\s+(gbrain_cl_\S+)/);
      const secretMatch = regOutput.match(/Client Secret:\s+(gbrain_cs_\S+)/);
      expect(idMatch).not.toBeNull();
      expect(secretMatch).not.toBeNull();
      const id = idMatch![1];
      const secret = secretMatch![1];
      dcrClientIds.push(id); // afterAll cleanup

      // Set a 24-hour TTL.
      await sql`UPDATE oauth_clients SET token_ttl = 86400 WHERE client_id = ${id}`;

      // Mint a token. Response must include expires_in close to 86400.
      const tokenRes = await fetch(`${BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${id}&client_secret=${secret}&scope=read`,
      });
      expect(tokenRes.ok).toBe(true);
      const body = await tokenRes.json() as any;
      expect(body.expires_in).toBe(86400);

      // Update TTL to a different value mid-test, mint again, assert new value.
      await sql`UPDATE oauth_clients SET token_ttl = 7200 WHERE client_id = ${id}`;
      const tokenRes2 = await fetch(`${BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${id}&client_secret=${secret}&scope=read`,
      });
      expect(tokenRes2.ok).toBe(true);
      const body2 = await tokenRes2.json() as any;
      expect(body2.expires_in).toBe(7200);

      // NULL token_ttl falls back to server default (3600 = 1 hour).
      await sql`UPDATE oauth_clients SET token_ttl = NULL WHERE client_id = ${id}`;
      const tokenRes3 = await fetch(`${BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${id}&client_secret=${secret}&scope=read`,
      });
      expect(tokenRes3.ok).toBe(true);
      const body3 = await tokenRes3.json() as any;
      expect(body3.expires_in).toBe(3600);
    } finally {
      await sql.end();
    }
  }, 30_000);

  // =========================================================================
  // v0.26.3: magic-link single-use + 401 styled error page
  // =========================================================================
  //
  // D11=C: /admin/auth/:nonce is single-use. First click consumes the nonce,
  // second click fails with the styled 401 page. No bootstrap token in URL.
  //
  // Also covers F6.5: server returns Content-Type: text/html on the 401
  // path (Express auto-sets this for HTML body) so browsers render the
  // styled page instead of treating it as plain text.

  test('v0.26.3: invalid magic-link nonce returns styled 401 HTML page', async () => {
    const res = await fetch(`${BASE}/admin/auth/garbage_nonce_that_does_not_exist`, { redirect: 'manual' });
    expect(res.status).toBe(401);
    const ct = res.headers.get('content-type') || '';
    expect(ct).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('expired');
    expect(body).toContain('GBrain');
  });

  test('v0.26.3: magic-link nonce is single-use (second click fails)', async () => {
    // Mint a one-time nonce.
    const issueRes = await fetch(`${BASE}/admin/api/issue-magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: ['Bearer', ADMIN_BOOTSTRAP_TOKEN].join(' ') },
      body: '{}',
    });
    expect(issueRes.ok).toBe(true);
    const { url } = await issueRes.json() as any;
    expect(url).toContain('/admin/auth/');

    // First click — should set cookie + redirect (302 to /admin/).
    const first = await fetch(url, { redirect: 'manual' });
    expect(first.status).toBe(302);
    const cookie = first.headers.get('set-cookie') || '';
    expect(cookie).toContain('gbrain_admin=');

    // Second click on the same URL — must fail (single-use consumed).
    const second = await fetch(url, { redirect: 'manual' });
    expect(second.status).toBe(401);
    const secondBody = await second.text();
    expect(secondBody).toContain('GBrain');
  }, 15_000);

  // =========================================================================
  // v0.26.3: agent_name backfill across oauth_clients + access_tokens
  // =========================================================================
  //
  // Migration v33 backfills mcp_request_log.agent_name using
  //   COALESCE(oauth_clients.client_name, access_tokens.name, token_name)
  // This test confirms the agent_name is correctly resolved across both
  // auth lanes (oauth client + legacy api key).

  test('v0.26.3: agent_name resolves correctly for OAuth + legacy paths', async () => {
    const postgres = (await import('postgres')).default;
    const sql = postgres(process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '', { prepare: false });
    try {
      // Make an OAuth-authenticated request — agent_name should be the OAuth client_name.
      const tokenRes = await fetch(`${BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${clientId!}&client_secret=${clientSecret!}&scope=read`,
      });
      const { access_token } = await tokenRes.json() as any;
      await mcpCall(access_token, 'tools/list');
      await new Promise(r => setTimeout(r, 250));

      const oauthRows = await sql`
        SELECT agent_name FROM mcp_request_log
        WHERE token_name = ${clientId!}
        ORDER BY created_at DESC LIMIT 1
      ` as unknown as Array<{ agent_name: string }>;
      expect(oauthRows.length).toBeGreaterThan(0);
      expect(oauthRows[0].agent_name).toBe('e2e-oauth-test');
    } finally {
      await sql.end();
    }
  }, 15_000);

  // =========================================================================
  // v0.26.3: register-client missing-name returns 400
  // =========================================================================
  //
  // Defense-in-depth: the admin register-client endpoint must validate
  // input. Pre-fix would have crashed or returned 500.

  test('v0.26.3: /admin/api/register-client without name returns 400', async () => {
    // Endpoint is admin-cookie-gated. Without auth we should get 401, not 500.
    // Without a name in the body (with auth) we should get 400. We test the
    // 401 path here as a basic input-validation smoke; the 400 path requires
    // an admin session which the test fixture doesn't easily produce.
    const res = await fetch(`${BASE}/admin/api/register-client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  // =========================================================================
  // F7 + F7b: HTTP MCP shell-job RCE regression
  // =========================================================================
  //
  // The headline trust-boundary fix. Pre-fix, the inlined OperationContext
  // literal in serve-http.ts forgot to set `remote: true`, which meant
  // operations.ts:1391's protected-job-name guard (`if (ctx.remote && ...)`)
  // saw a falsy undefined and skipped. An HTTP MCP caller with a write-scoped
  // token could then submit `{name: "shell", params: {cmd: "id"}}` over /mcp
  // and execute arbitrary commands on the gbrain host.
  //
  // The fix is two-layered:
  //   1) F7  — serve-http.ts sets `remote: true` explicitly.
  //   2) F7b — operations.ts:1391 + :1400 use `ctx.remote !== false` /
  //            `ctx.remote === false` so undefined fails closed even if a
  //            future transport bypasses the type via cast.
  //
  // Together they close the path even if either layer regresses alone.

  test('F7: HTTP MCP cannot submit shell jobs (RCE regression)', async () => {
    // v0.28.10: must mint admin scope. submit_job's required scope is
    // 'admin'; without it, hasScope() rejects with insufficient_scope BEFORE
    // the F7 protected-name guard at operations.ts:1527 fires. To validate
    // the actual RCE protection (the protected-name guard), the token has
    // to clear the scope check first.
    const { access_token } = await mintToken('admin');
    const res = await mcpCall(access_token, 'tools/call', {
      name: 'submit_job',
      arguments: { name: 'shell', data: { cmd: 'id' } },
    });

    const body = await res.text();
    // Must reject. Either HTTP 4xx, or a JSON-RPC envelope carrying an
    // OperationError with code permission_denied. The exact wire shape
    // depends on SDK error mapping — assert the negative invariant
    // (no command executed) and the positive invariant (rejection signal).
    const rejected =
      res.status >= 400 ||
      body.includes('permission_denied') ||
      body.includes('cannot be submitted over MCP');
    expect(rejected).toBe(true);

    // Negative: response must NOT contain a successful submit_job result
    // (which would surface a job_id field). If a job ID came back the
    // privesc landed.
    expect(body).not.toMatch(/"job_id"\s*:\s*"?\d+/);
  }, 15_000);

  test('F7: HTTP MCP cannot submit subagent jobs (protected name)', async () => {
    // Same admin-scope requirement as the shell-job sibling test above.
    const { access_token } = await mintToken('admin');
    const res = await mcpCall(access_token, 'tools/call', {
      name: 'submit_job',
      arguments: { name: 'subagent', data: { prompt: 'noop' } },
    });
    const body = await res.text();
    const rejected =
      res.status >= 400 ||
      body.includes('permission_denied') ||
      body.includes('cannot be submitted over MCP');
    expect(rejected).toBe(true);
    expect(body).not.toMatch(/"job_id"\s*:\s*"?\d+/);
  }, 15_000);

  // =========================================================================
  // C4: scope-gate sweep over the real server
  // =========================================================================
  //
  // Pins the EXACT insufficient_scope envelope serve-http's scope-deny branch
  // returns (serve-http.ts CallToolRequestSchema handler), the
  // status='denied_after_list' request-log row it writes (amendment 33: a
  // call-time scope deny is a list-level denial because tools/list uses the
  // same hasScope predicate), the FOV-4 agentCallable carve-out, and the
  // scope-filtered tools/list. Every denied assertion pairs with an allowed
  // control on the same token (anti-vacuity).

  test('C4: read-only token — put_page returns the exact insufficient_scope envelope + denied_after_list row; search allowed (control)', async () => {
    const { id, secret } = await ensureC45Client();
    const readToken = await mintFor(id, secret, 'read');

    // Denied: put_page requires 'write'.
    const denied = await mcpToolResult(readToken, 'tools/call', {
      name: 'put_page',
      arguments: { slug: 'e2e-c4-denied', content: '---\ntitle: t\n---\nbody' },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0].text)).toEqual({
      error: 'insufficient_scope',
      message: "Operation put_page requires 'write' scope",
      your_scopes: ['read'],
    });

    // Allowed control (anti-vacuity): same token, read op succeeds.
    const allowed = await mcpToolResult(readToken, 'tools/call', {
      name: 'search',
      arguments: { query: 'e2e-c4-control', limit: 1 },
    });
    expect(allowed.isError).not.toBe(true);

    await withSql(async (sql) => {
      const rows = await pollLogRows(sql, id, r =>
        r.some(row => row.operation === 'put_page') && r.some(row => row.operation === 'search'));
      const deniedRow = rows.find(row => row.operation === 'put_page');
      expect(deniedRow).toBeDefined();
      expect(deniedRow!.status).toBe('denied_after_list');
      expect(deniedRow!.error_message).toBe("insufficient_scope: requires 'write'");
      // Control row: the allowed read logs plain success (not denied).
      const controlRow = rows.filter(row => row.operation === 'search').pop();
      expect(controlRow).toBeDefined();
      expect(controlRow!.status).toBe('success');
    });
  }, 30_000);

  test('C4: agent-scope token CAN call request_tools (agentCallable carve-out) but NOT get_page', async () => {
    const agent = await registerThrowawayClient(`e2e-c4-agent-${Date.now()}`, 'agent');
    const agentToken = await mintFor(agent.id, agent.secret, 'agent');

    // Carve-out (allowed control): request_tools is agentCallable, so an
    // agent-only token gets the catalog instead of a scope deny.
    const catalogRes = await mcpToolResult(agentToken, 'tools/call', {
      name: 'request_tools',
      arguments: {},
    });
    expect(catalogRes.isError).not.toBe(true);
    const catalog = JSON.parse(catalogRes.content[0].text);
    expect(Array.isArray(catalog.catalog)).toBe(true);
    expect(catalog.total_tools).toBeGreaterThan(0);

    // Denied: get_page (scope 'read', not agentCallable) — agent does NOT
    // imply read (v0.38 D13: agent is a sibling scope).
    const denied = await mcpToolResult(agentToken, 'tools/call', {
      name: 'get_page',
      arguments: { slug: 'e2e-c4-agent-denied' },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0].text)).toEqual({
      error: 'insufficient_scope',
      message: "Operation get_page requires 'read' scope",
      your_scopes: ['agent'],
    });

    await withSql(async (sql) => {
      const rows = await pollLogRows(sql, agent.id, r =>
        r.some(row => row.operation === 'request_tools') && r.some(row => row.operation === 'get_page'));
      expect(rows.find(row => row.operation === 'request_tools')!.status).toBe('success');
      const deniedRow = rows.find(row => row.operation === 'get_page')!;
      expect(deniedRow.status).toBe('denied_after_list');
      expect(deniedRow.error_message).toBe("insufficient_scope: requires 'read'");
    });
  }, 30_000);

  test('C4: tools/list is scope-filtered — read token excludes write/admin tools; write token sees put_page (control)', async () => {
    const { id, secret } = await ensureC45Client();
    const readToken = await mintFor(id, secret, 'read');
    const writeToken = await mintFor(id, secret, 'read write');

    const readList = await mcpToolResult(readToken, 'tools/list');
    const readNames: string[] = readList.tools.map((t: any) => t.name);
    expect(readNames).toContain('search');
    expect(readNames).toContain('get_page');
    expect(readNames).not.toContain('put_page');   // write-scoped
    expect(readNames).not.toContain('submit_job'); // admin-scoped

    // Control (anti-vacuity): the same client with write scope DOES see
    // put_page — the exclusion above is the filter, not a missing tool.
    const writeList = await mcpToolResult(writeToken, 'tools/list');
    const writeNames: string[] = writeList.tools.map((t: any) => t.name);
    expect(writeNames).toContain('put_page');
    expect(writeNames).not.toContain('submit_job'); // write does not imply admin
    expect(writeNames.length).toBeGreaterThan(readNames.length);
  }, 15_000);

  // =========================================================================
  // C5: request-log row shapes — success_with_warnings + tool_count
  // =========================================================================

  test("C5: warn-mode unknown param — successful call logs status='success_with_warnings'; clean call logs 'success' (control)", async () => {
    const { id, secret } = await ensureC45Client();
    const token = await mintFor(id, secret, 'read');

    // WP3 amendment 13: under mcp.strict_params 'warn' (the default — this
    // server sets no override), an unknown argument on a successful call
    // surfaces on _meta.warnings, and requestLogStatusForResult flips the
    // row to 'success_with_warnings'.
    const warned = await mcpToolResult(token, 'tools/call', {
      name: 'search',
      arguments: { query: 'e2e-c5-warn', limit: 1, bogus_unknown_param: 'x' },
    });
    expect(warned.isError).not.toBe(true);
    const warnings = warned._meta?.warnings;
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings.some((w: any) => w.code === 'unknown_param' && w.param === 'bogus_unknown_param')).toBe(true);
    // The model-visible warn notice rides as an extra content block (D8).
    expect(warned.content.some((c: any) => typeof c.text === 'string'
      && c.text.includes('unknown parameter "bogus_unknown_param"'))).toBe(true);

    // Control (anti-vacuity): same op with only declared params.
    const clean = await mcpToolResult(token, 'tools/call', {
      name: 'search',
      arguments: { query: 'e2e-c5-clean', limit: 1 },
    });
    expect(clean.isError).not.toBe(true);

    await withSql(async (sql) => {
      const rows = await pollLogRows(sql, id, r =>
        r.some(row => row.operation === 'search' && row.status === 'success_with_warnings'));
      expect(rows.some(row => row.operation === 'search' && row.status === 'success_with_warnings')).toBe(true);
      // The clean sibling stays plain 'success' — the warn status is
      // attributable to the unknown key, not to search generally.
      expect(rows.some(row => row.operation === 'search' && row.status === 'success')).toBe(true);
    });
  }, 30_000);

  test("C5: tools/list writes a row whose params->>'tool_count' matches the returned list size", async () => {
    const { id, secret } = await ensureC45Client();
    const token = await mintFor(id, secret, 'read');

    const before = await withSql(async (sql) => {
      const [row] = await sql`
        SELECT count(*)::int AS n FROM mcp_request_log
        WHERE token_name = ${id} AND operation = 'tools/list'
      `;
      return Number(row.n);
    });

    const list = await mcpToolResult(token, 'tools/list');
    expect(Array.isArray(list.tools)).toBe(true);
    expect(list.tools.length).toBeGreaterThan(0);

    await withSql(async (sql) => {
      const rows = await pollLogRows(sql, id, r =>
        r.filter(row => row.operation === 'tools/list').length > before);
      const listRows = rows.filter(row => row.operation === 'tools/list');
      expect(listRows.length).toBeGreaterThan(before);
      const latest = listRows[listRows.length - 1];
      expect(latest.status).toBe('success');
      // params->>'tool_count' is populated and equals the list this token got.
      expect(latest.tool_count).toBe(String(list.tools.length));
      expect(Number(latest.tool_count)).toBeGreaterThan(0);
    });
  }, 30_000);

  // =========================================================================
  // C6: adminAuthRateLimiter covers /admin/login + /admin/api/issue-magic-link
  // =========================================================================
  //
  // The limiter (serve-http.ts adminAuthRateLimiter: windowMs 60s, max 10,
  // shared bucket per IP across /admin/login, /admin/api/issue-magic-link,
  // and /admin/auth/:token) previously guarded only the magic-link redeem
  // route, leaving the two POST credential surfaces unmetered.
  //
  // BUDGET NOTE: the bucket is shared across the whole suite run. Existing
  // tests consume up to 6 limited requests; the non-exhaustion C6 test below
  // consumes 4 more (worst case exactly at max=10 if everything lands in one
  // 60s window — max requests are still allowed, max+1 is the first 429).
  // The exhaustion test MUST stay the last test in this file: it deliberately
  // drains the bucket, so any admin-route request after it would 429.

  test('C6: wrong admin credentials get 401 with no session artifacts; correct credentials still succeed (control)', async () => {
    // (a) Wrong token on /admin/login → 401 and NO gbrain_admin cookie.
    const badLogin = await fetch(`${BASE}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'definitely-not-the-bootstrap-token' }),
    });
    expect(badLogin.status).toBe(401);
    expect(badLogin.headers.get('set-cookie') || '').not.toContain('gbrain_admin=');
    expect(((await badLogin.json()) as any).error).toBe('Invalid token. Check your terminal output.');

    // (a) Wrong bearer on /admin/api/issue-magic-link → 401, no URL minted.
    const badLink = await fetch(`${BASE}/admin/api/issue-magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer definitely-not-the-bootstrap-token' },
      body: '{}',
    });
    expect(badLink.status).toBe(401);
    const badLinkBody = await badLink.json() as any;
    expect(badLinkBody.url).toBeUndefined();
    expect(badLinkBody.error).toBe('Invalid bootstrap token');

    // (c) HAPPY PATH controls — a correct token below the limit keeps its
    // normal success (the regression the limiter could introduce).
    const cookie = await adminCookie(); // asserts 200 + gbrain_admin cookie
    expect(cookie).toContain('gbrain_admin=');

    const issue = await fetch(`${BASE}/admin/api/issue-magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_BOOTSTRAP_TOKEN}` },
      body: '{}',
    });
    expect(issue.status).toBe(200);
    expect(((await issue.json()) as any).url).toContain('/admin/auth/');
  }, 15_000);

  // MUST REMAIN THE LAST TEST IN THIS FILE — drains the shared admin-auth
  // rate-limit bucket (see budget note above).
  test('C6: exceeding the admin-auth rate limit returns 429 with Retry-After', async () => {
    // adminAuthRateLimiter: max 10 per 60s window. Drive wrong-token logins
    // until the limiter trips. Prior tests may have consumed part of the
    // bucket (shared per-IP), so the 429 can arrive early; 23 attempts
    // guarantees crossing max+1 even if a fixed-window reset lands mid-loop.
    let limited: Response | null = null;
    const preLimitStatuses: number[] = [];
    for (let i = 0; i < 23; i++) {
      const res = await fetch(`${BASE}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'wrong-token-for-rate-limit' }),
      });
      if (res.status === 429) { limited = res; break; }
      preLimitStatuses.push(res.status);
      await res.text(); // drain body
    }

    expect(limited).not.toBeNull();
    // Every request below the limit stayed a normal 401 (the limiter meters,
    // it does not reject early).
    for (const s of preLimitStatuses) expect(s).toBe(401);

    // Retry-After (seconds until the window resets, capped by the 60s window).
    const retryAfter = limited!.headers.get('retry-after');
    expect(retryAfter).toBeTruthy();
    const retrySecs = Number(retryAfter);
    expect(Number.isFinite(retrySecs)).toBe(true);
    expect(retrySecs).toBeGreaterThan(0);
    expect(retrySecs).toBeLessThanOrEqual(60);

    // standardHeaders: true → draft RateLimit headers carry the max (10).
    expect(limited!.headers.get('ratelimit-limit')).toBe('10');

    // Body is the limiter's configured JSON envelope (object message →
    // express-rate-limit serializes it as JSON, matching the /admin routes).
    const limitedBody = JSON.parse(await limited!.text()) as { error: string; message: string };
    expect(limitedBody.error).toBe('rate_limited');
    expect(limitedBody.message).toContain('Too many admin auth attempts');
  }, 60_000);
});
