/**
 * Integration tests for serve-http.ts OAuth fixes (v0.26.1).
 *
 * Tests the three fixes:
 *   1. client_credentials tokens validate at /mcp (expiresAt is number)
 *   2. OAuth metadata includes client_credentials in grant_types_supported
 *   3. Express 5 trust proxy + admin SPA wildcard
 *
 * Requires DATABASE_URL (uses real Postgres for OAuth tables).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

const DATABASE_URL = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  describe.skip('serve-http-oauth (no DATABASE_URL)', () => {
    test('skipped', () => {});
  });
} else {

  // Dynamic import to avoid top-level side effects when skipping
  let fetch: typeof globalThis.fetch;
  let serverProcess: any;
  const PORT = 19131; // Avoid collision with production 3131

  describe('serve-http OAuth fixes (v0.26.1)', () => {
    let clientId: string;
    let clientSecret: string;

    beforeAll(async () => {
      fetch = globalThis.fetch;

      // Register a test OAuth client via CLI (uses the correct DB connection)
      const { execSync } = await import('child_process');
      const regOutput = execSync(
        'bun run src/cli.ts auth register-client serve-http-test --grant-types client_credentials --scopes "read write"',
        { cwd: process.cwd(), env: { ...process.env, GBRAIN_DATABASE_URL: DATABASE_URL }, encoding: 'utf8' }
      );
      // Parse client_id and client_secret from output
      const idMatch = regOutput.match(/Client ID:\s+(gbrain_cl_\S+)/);
      const secretMatch = regOutput.match(/Client Secret:\s+(gbrain_cs_\S+)/);
      if (!idMatch || !secretMatch) throw new Error('Failed to register test client: ' + regOutput);
      clientId = idMatch[1];
      clientSecret = secretMatch[1];

      // Start the server in background
      const { spawn } = await import('child_process');
      serverProcess = spawn('bun', [
        'run', 'src/cli.ts', 'serve', '--http',
        '--port', String(PORT),
        '--public-url', `http://localhost:${PORT}`,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, GBRAIN_DATABASE_URL: DATABASE_URL },
        stdio: 'pipe',
      });

      // Wait for server to be ready
      for (let i = 0; i < 30; i++) {
        try {
          const res = await fetch(`http://localhost:${PORT}/health`);
          if (res.ok) break;
        } catch {}
        await new Promise(r => setTimeout(r, 500));
      }

      // sql was removed — registration now uses CLI
    }, 30_000);

    afterAll(async () => {
      if (serverProcess) {
        serverProcess.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 1000));
      }
      // Revoke test client
      try {
        const { execSync } = await import('child_process');
        execSync(`bun run src/cli.ts auth revoke-client "${clientId}"`,
          { cwd: process.cwd(), env: { ...process.env, GBRAIN_DATABASE_URL: DATABASE_URL }, encoding: 'utf8' });
      } catch {}
    });

    // -----------------------------------------------------------------
    // Fix 1: expiresAt is number, not string
    // -----------------------------------------------------------------

    test('client_credentials token is accepted at /mcp (expiresAt number cast)', async () => {
      // Mint token
      const tokenRes = await fetch(`http://localhost:${PORT}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}&scope=read+write`,
      });
      expect(tokenRes.ok).toBe(true);
      const tokenData = await tokenRes.json() as any;
      expect(tokenData.access_token).toBeDefined();
      expect(tokenData.expires_in).toBe(3600);

      // Use token at /mcp — this is the actual regression test
      const mcpRes = await fetch(`http://localhost:${PORT}/mcp`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });

      // Before fix: 401 {"error":"invalid_token","error_description":"Token has no expiration time"}
      // After fix: 200 with SSE stream containing tool list
      expect(mcpRes.status).not.toBe(401);

      const body = await mcpRes.text();
      // Should contain tools/list response (SSE format)
      expect(body).toContain('tools');
    }, 15_000);

    test('token expires_in matches server TTL', async () => {
      const tokenRes = await fetch(`http://localhost:${PORT}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}&scope=read`,
      });
      const data = await tokenRes.json() as any;
      expect(data.expires_in).toBe(3600);
      expect(data.token_type).toBe('bearer');
      expect(data.scope).toBe('read');
    });

    // -----------------------------------------------------------------
    // Fix 2: OAuth metadata includes client_credentials
    // -----------------------------------------------------------------

    test('OAuth AS metadata includes client_credentials grant type', async () => {
      const res = await fetch(`http://localhost:${PORT}/.well-known/oauth-authorization-server`);
      expect(res.ok).toBe(true);
      const meta = await res.json() as any;
      expect(meta.grant_types_supported).toContain('authorization_code');
      expect(meta.grant_types_supported).toContain('refresh_token');
      expect(meta.grant_types_supported).toContain('client_credentials');
    });

    test('token endpoint is discoverable from metadata', async () => {
      const res = await fetch(`http://localhost:${PORT}/.well-known/oauth-authorization-server`);
      const meta = await res.json() as any;
      expect(meta.token_endpoint).toContain('/token');
      expect(meta.issuer).toBeDefined();
    });

    // -----------------------------------------------------------------
    // Fix 3: Express 5 compat
    // -----------------------------------------------------------------

    test('admin dashboard serves index.html (Express 5 wildcard fix)', async () => {
      const res = await fetch(`http://localhost:${PORT}/admin/`);
      // Should return the SPA HTML, not Express error page
      const html = await res.text();
      expect(html).toContain('GBrain Admin');
      expect(html).not.toContain('<pre>Cannot GET');
    });

    test('X-Forwarded-For header does not crash rate limiter', async () => {
      const res = await fetch(`http://localhost:${PORT}/health`, {
        headers: { 'X-Forwarded-For': '10.0.0.1' },
      });
      // Before fix: 500 ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
      expect(res.ok).toBe(true);
    });

    // -----------------------------------------------------------------
    // Scope enforcement
    // -----------------------------------------------------------------

    test('read-only token cannot call write operations', async () => {
      const tokenRes = await fetch(`http://localhost:${PORT}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}&scope=read`,
      });
      const { access_token } = await tokenRes.json() as any;

      // Try a write operation (put_page)
      const mcpRes = await fetch(`http://localhost:${PORT}/mcp`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'put_page', arguments: { slug: 'test-scope', content: '---\ntitle: test\n---\ntest' } },
        }),
      });

      const body = await mcpRes.text();
      // Should be rejected (403 or error in response)
      // The exact behavior depends on scope enforcement — either HTTP 403 or JSON-RPC error
      expect(mcpRes.status === 403 || body.includes('scope') || body.includes('Insufficient')).toBe(true);
    }, 15_000);
  });
}
