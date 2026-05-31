/**
 * E2E HTTP OAuth runtime smoke.
 *
 * This simulates a ChatGPT-style OAuth client against the real Bun HTTP MCP
 * server and a real Postgres database. It does not require ChatGPT, OpenAI, or
 * Anthropic credentials.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { resolveConfig } from '../../src/core/config.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { createMcpHttpHandler } from '../../src/mcp/http-server.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const smokeScriptPath = `${repoRoot}/scripts/smoke-test-http-oauth.ts`;

test('package exposes the HTTP OAuth smoke command', () => {
  const packageJson = JSON.parse(readFileSync(`${repoRoot}/package.json`, 'utf-8')) as {
    scripts?: Record<string, string>;
  };

  expect(packageJson.scripts?.['smoke:http-oauth']).toBe('bun run scripts/smoke-test-http-oauth.ts');
  expect(existsSync(smokeScriptPath)).toBe(true);
});

test('HTTP OAuth smoke rejects public issuer URLs with embedded credentials', async () => {
  const smoke = await import('../../scripts/smoke-test-http-oauth.ts') as {
    runHttpOAuthSmoke: (options: {
      databaseUrl: string;
      publicBaseUrl: string;
    }) => Promise<unknown>;
  };

  await expect(smoke.runHttpOAuthSmoke({
    databaseUrl: 'postgresql://postgres:postgres@localhost:5432/mbrain_test',
    publicBaseUrl: 'https://user:pass@brain.example.com/',
  })).rejects.toThrow('must not include username or password');
});

test('HTTP OAuth smoke rejects non-HTTPS public issuers before touching the runtime', async () => {
  const smoke = await import('../../scripts/smoke-test-http-oauth.ts') as {
    runHttpOAuthSmoke: (options: {
      databaseUrl: string;
      publicBaseUrl: string;
    }) => Promise<unknown>;
  };

  expect(smoke.runHttpOAuthSmoke({
    databaseUrl: 'postgresql://postgres:postgres@localhost:1/mbrain_test',
    publicBaseUrl: 'http://localhost:8787',
  })).rejects.toThrow('public OAuth issuer must be an HTTPS URL');
});

const describeE2E = hasDatabase() ? describe : describe.skip;

describeE2E('E2E: HTTP OAuth runtime smoke', () => {
  beforeAll(setupDB);
  afterAll(teardownDB);

  test('keeps OAuth DCR schema free of dormant revocation state', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        SELECT table_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('access_tokens', 'oauth_dcr_clients')
          AND column_name = 'revoked_at'
        ORDER BY table_name
      `;

      expect(rows.map(row => row.table_name)).toEqual(['access_tokens']);
    } finally {
      await sql.end();
    }
  });

  test('completes OAuth/DCR/PKCE over the real HTTP server and records Postgres evidence', async () => {
    const smoke = await import('../../scripts/smoke-test-http-oauth.ts') as {
      runHttpOAuthSmoke: (options: {
        databaseUrl: string;
        host: string;
        port: number;
        approvalToken: string;
        signingSecret: string;
        cleanup: boolean;
        publicBaseUrl?: string;
      }) => Promise<{
        baseUrl: string;
        oauthIssuer: string;
        accessTokenRows: number;
        requestLogRows: number;
        logOperations: string[];
        refreshedTokenWorked: boolean;
        initialTokenRejectedAfterRefresh: boolean;
      }>;
    };

    const consoleLogs: unknown[][] = [];
    const originalLog = console.log;
    const originalPublicUrl = process.env.MBRAIN_HTTP_PUBLIC_URL;
    let result: Awaited<ReturnType<typeof smoke.runHttpOAuthSmoke>>;
    console.log = (...args: unknown[]) => {
      consoleLogs.push(args);
    };
    delete process.env.MBRAIN_HTTP_PUBLIC_URL;
    try {
      result = await smoke.runHttpOAuthSmoke({
        databaseUrl: process.env.DATABASE_URL!,
        host: '127.0.0.1',
        port: 0,
        approvalToken: 'owner-secret',
        signingSecret: 'test-signing-secret',
        cleanup: false,
      });
    } finally {
      console.log = originalLog;
      if (originalPublicUrl === undefined) {
        delete process.env.MBRAIN_HTTP_PUBLIC_URL;
      } else {
        process.env.MBRAIN_HTTP_PUBLIC_URL = originalPublicUrl;
      }
    }

    expect(result.baseUrl).toStartWith('http://127.0.0.1:');
    expect(result.oauthIssuer).toBe(result.baseUrl);
    expect(result.accessTokenRows).toBeGreaterThanOrEqual(2);
    expect(result.requestLogRows).toBeGreaterThanOrEqual(4);
    expect(result.logOperations).toEqual(expect.arrayContaining([
      'initialize',
      'tools/list',
      'get_stats',
    ]));
    expect(result.refreshedTokenWorked).toBe(true);
    expect(result.initialTokenRejectedAfterRefresh).toBe(true);
    expect(consoleLogs).toEqual([]);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const accessTokens = await sql`
        SELECT name, scopes, last_used_at, revoked_at FROM access_tokens
        WHERE name = 'oauth:MBrain OAuth Smoke'
        ORDER BY created_at
      `;
      expect(accessTokens.length).toBeGreaterThanOrEqual(2);
      expect(accessTokens.every(row => Array.isArray(row.scopes) && row.scopes.includes('mcp'))).toBe(true);
      expect(accessTokens.every(row => row.last_used_at !== null)).toBe(true);
      expect(accessTokens.filter(row => row.revoked_at !== null)).toHaveLength(1);
      expect(accessTokens.filter(row => row.revoked_at === null)).toHaveLength(accessTokens.length - 1);

      const logs = await sql`
        SELECT token_name, operation, status FROM mcp_request_log
        WHERE token_name = 'oauth:MBrain OAuth Smoke'
        ORDER BY created_at
      `;
      expect(logs.map(row => row.operation)).toEqual(expect.arrayContaining([
        'initialize',
        'tools/list',
        'get_stats',
      ]));
      expect(logs.every(row => row.status === 'success')).toBe(true);
    } finally {
      await sql`
        DELETE FROM mcp_request_log
        WHERE token_name = 'oauth:MBrain OAuth Smoke'
      `;
      await sql`
        DELETE FROM access_tokens
        WHERE name = 'oauth:MBrain OAuth Smoke'
      `;
      await sql`
        DELETE FROM oauth_dcr_clients
        WHERE client_name = 'MBrain OAuth Smoke'
      `;
      await sql.end();
    }
  });

  test('validates configured public OAuth issuer while exercising the local server', async () => {
    const smoke = await import('../../scripts/smoke-test-http-oauth.ts') as {
      runHttpOAuthSmoke: (options: {
        databaseUrl: string;
        host: string;
        port: number;
        publicBaseUrl: string;
        approvalToken: string;
        signingSecret: string;
        cleanup: boolean;
      }) => Promise<{
        baseUrl: string;
        oauthIssuer: string;
        accessTokenRows: number;
        requestLogRows: number;
        logOperations: string[];
        refreshedTokenWorked: boolean;
        initialTokenRejectedAfterRefresh: boolean;
      }>;
    };

    const result = await smoke.runHttpOAuthSmoke({
      databaseUrl: process.env.DATABASE_URL!,
      host: '127.0.0.1',
      port: 0,
      publicBaseUrl: 'https://brain.example.com/',
      approvalToken: 'owner-secret',
      signingSecret: 'test-signing-secret',
      cleanup: false,
    });

    expect(result.baseUrl).toStartWith('http://127.0.0.1:');
    expect(result.oauthIssuer).toBe('https://brain.example.com');
    expect(result.accessTokenRows).toBeGreaterThanOrEqual(2);
    expect(result.requestLogRows).toBeGreaterThanOrEqual(4);
    expect(result.logOperations).toEqual(expect.arrayContaining([
      'initialize',
      'tools/list',
      'get_stats',
    ]));
    expect(result.refreshedTokenWorked).toBe(true);
    expect(result.initialTokenRejectedAfterRefresh).toBe(true);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql`
        DELETE FROM mcp_request_log
        WHERE token_name = 'oauth:MBrain OAuth Smoke'
      `;
      await sql`
        DELETE FROM access_tokens
        WHERE name = 'oauth:MBrain OAuth Smoke'
      `;
      await sql`
        DELETE FROM oauth_dcr_clients
        WHERE client_name = 'MBrain OAuth Smoke'
      `;
    } finally {
      await sql.end();
    }
  });

  test('persists OAuth clients and authorization codes across handler restarts', async () => {
    const config = resolveConfig({
      engine: 'postgres',
      database_url: process.env.DATABASE_URL!,
      offline: false,
      embedding_provider: 'none',
      query_rewrite_provider: 'none',
    });
    const engine = new PostgresEngine();
    await engine.connect({ database_url: process.env.DATABASE_URL! });

    const oauth = {
      enabled: true,
      publicBaseUrl: 'https://brain.example.com',
      approvalToken: 'owner-secret',
      signingSecret: 'test-signing-secret',
    };
    const makeHandler = () => createMcpHttpHandler({ engine, config, oauth });
    const redirectUri = 'https://chat.openai.com/aip/callback';
    const verifier = 'restart-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    try {
      const register = await makeHandler()(new Request('http://localhost/oauth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Restarting ChatGPT',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
        }),
      }));
      expect(register.status).toBe(201);
      const client = await register.json() as { client_id: string };

      const authorize = await makeHandler()(new Request('http://localhost/oauth/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        redirect: 'manual',
        body: new URLSearchParams({
          approval_token: 'owner-secret',
          response_type: 'code',
          client_id: client.client_id,
          redirect_uri: redirectUri,
          state: 'restart-state',
          scope: 'mcp',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }),
      }));
      expect(authorize.status).toBe(302);
      const redirect = new URL(authorize.headers.get('Location')!);
      expect(redirect.searchParams.get('state')).toBe('restart-state');
      const code = redirect.searchParams.get('code');
      expect(code).toEqual(expect.any(String));

      const token = await makeHandler()(new Request('http://localhost/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          redirect_uri: redirectUri,
          code: code!,
          code_verifier: verifier,
        }),
      }));
      expect(token.status).toBe(200);
      const payload = await token.json() as { access_token: string };
      expect(payload.access_token).toStartWith('mbrain_');

      const tools = await makeHandler()(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${payload.access_token}`,
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }),
      }));
      expect(tools.status).toBe(200);
    } finally {
      const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        await sql`
          DELETE FROM mcp_request_log
          WHERE token_name = 'oauth:Restarting ChatGPT'
        `;
        await sql`
          DELETE FROM access_tokens
          WHERE name = 'oauth:Restarting ChatGPT'
        `;
        await sql`
          DELETE FROM oauth_dcr_clients
          WHERE client_name = 'Restarting ChatGPT'
        `;
      } finally {
        await sql.end();
        await engine.disconnect();
      }
    }
  });

  test('atomically consumes Postgres authorization codes under concurrent exchange', async () => {
    const config = resolveConfig({
      engine: 'postgres',
      database_url: process.env.DATABASE_URL!,
      offline: false,
      embedding_provider: 'none',
      query_rewrite_provider: 'none',
    });
    const engine = new PostgresEngine();
    await engine.connect({ database_url: process.env.DATABASE_URL! });

    const oauth = {
      enabled: true,
      publicBaseUrl: 'https://brain.example.com',
      approvalToken: 'owner-secret',
      signingSecret: 'test-signing-secret',
    };
    const handler = createMcpHttpHandler({ engine, config, oauth });
    const redirectUri = 'https://chat.openai.com/aip/callback';
    const verifier = 'concurrent-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    try {
      const register = await handler(new Request('http://localhost/oauth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Concurrent ChatGPT',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
        }),
      }));
      expect(register.status).toBe(201);
      const client = await register.json() as { client_id: string };

      const authorize = await handler(new Request('http://localhost/oauth/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        redirect: 'manual',
        body: new URLSearchParams({
          approval_token: 'owner-secret',
          response_type: 'code',
          client_id: client.client_id,
          redirect_uri: redirectUri,
          state: 'concurrent-state',
          scope: 'mcp',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }),
      }));
      expect(authorize.status).toBe(302);
      const code = new URL(authorize.headers.get('Location')!).searchParams.get('code');
      expect(code).toEqual(expect.any(String));

      const exchangeCode = () => handler(new Request('http://localhost/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          redirect_uri: redirectUri,
          code: code!,
          code_verifier: verifier,
        }),
      }));

      const exchanges = await Promise.all(Array.from({ length: 8 }, () => exchangeCode()));
      const statuses = exchanges.map(response => response.status);
      expect(statuses.filter(status => status === 200)).toHaveLength(1);
      expect(statuses.filter(status => status === 400)).toHaveLength(7);

      const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        const tokens = await sql`
          SELECT id FROM access_tokens
          WHERE name = 'oauth:Concurrent ChatGPT'
        `;
        expect(tokens.length).toBe(1);
      } finally {
        await sql.end();
      }
    } finally {
      const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        await sql`
          DELETE FROM mcp_request_log
          WHERE token_name = 'oauth:Concurrent ChatGPT'
        `;
        await sql`
          DELETE FROM access_tokens
          WHERE name = 'oauth:Concurrent ChatGPT'
        `;
        await sql`
          DELETE FROM oauth_dcr_clients
          WHERE client_name = 'Concurrent ChatGPT'
        `;
      } finally {
        await sql.end();
        await engine.disconnect();
      }
    }
  });

  test('HTTP OAuth smoke can exercise persisted OAuth state across server restarts', async () => {
    const smoke = await import('../../scripts/smoke-test-http-oauth.ts') as {
      runHttpOAuthSmoke: (options: {
        databaseUrl: string;
        host: string;
        port: number;
        approvalToken: string;
        signingSecret: string;
        cleanup: boolean;
        restart: boolean;
      }) => Promise<{
        baseUrl: string;
        oauthIssuer: string;
        accessTokenRows: number;
        requestLogRows: number;
        logOperations: string[];
        refreshedTokenWorked: boolean;
        initialTokenRejectedAfterRefresh: boolean;
        restartResilient: boolean;
      }>;
    };

    const result = await smoke.runHttpOAuthSmoke({
      databaseUrl: process.env.DATABASE_URL!,
      host: '127.0.0.1',
      port: 0,
      approvalToken: 'owner-secret',
      signingSecret: 'test-signing-secret',
      cleanup: true,
      restart: true,
    });

    expect(result.baseUrl).toStartWith('http://127.0.0.1:');
    expect(result.oauthIssuer).toBe(result.baseUrl);
    expect(result.restartResilient).toBe(true);
    expect(result.accessTokenRows).toBeGreaterThanOrEqual(2);
    expect(result.requestLogRows).toBeGreaterThanOrEqual(4);
    expect(result.logOperations).toEqual(expect.arrayContaining([
      'initialize',
      'tools/list',
      'get_stats',
    ]));
    expect(result.refreshedTokenWorked).toBe(true);
    expect(result.initialTokenRejectedAfterRefresh).toBe(true);
  });

  test('bounds durable public DCR writes by pruning stale setup rows and capping pending clients', async () => {
    const config = resolveConfig({
      engine: 'postgres',
      database_url: process.env.DATABASE_URL!,
      offline: false,
      embedding_provider: 'none',
      query_rewrite_provider: 'none',
    });
    const engine = new PostgresEngine();
    await engine.connect({ database_url: process.env.DATABASE_URL! });
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

    const oauth = {
      enabled: true,
      publicBaseUrl: 'https://brain.example.com',
      approvalToken: 'owner-secret',
      signingSecret: 'test-signing-secret',
    };
    const handler = createMcpHttpHandler({ engine, config, oauth });
    const redirectUri = 'https://chat.openai.com/aip/callback';
    const pendingLimit = 128;
    const staleIssuedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const staleCodeHash = createHash('sha256').update('stale-code').digest('hex');

    const register = (clientName: string) => handler(new Request('http://localhost/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
      }),
    }));

    try {
      await sql`
        INSERT INTO oauth_dcr_clients (
          client_id, client_name, redirect_uris, token_endpoint_auth_method, issued_at
        )
        VALUES (
          'stale-pending-client',
          'Stale Pending Client',
          ${[redirectUri]},
          'none',
          ${staleIssuedAt}
        )
      `;
      await sql`
        INSERT INTO oauth_authorization_codes (
          code_hash, client_id, redirect_uri, code_challenge, scope, expires_at, created_at
        )
        VALUES (
          ${staleCodeHash},
          'stale-pending-client',
          ${redirectUri},
          'stale-challenge',
          ${['mcp']},
          ${staleIssuedAt},
          ${staleIssuedAt}
        )
      `;
      for (let i = 0; i < pendingLimit; i += 1) {
        await sql`
          INSERT INTO oauth_dcr_clients (
            client_id, client_name, redirect_uris, token_endpoint_auth_method, issued_at
          )
          VALUES (
            ${`pending-cap-${i}`},
            ${`Pending Cap ${i}`},
            ${[redirectUri]},
            'none',
            now()
          )
        `;
      }

      const capped = await register('Capacity ChatGPT');
      expect(capped.status).toBe(429);

      const staleClients = await sql`
        SELECT client_id FROM oauth_dcr_clients
        WHERE client_id = 'stale-pending-client'
      `;
      expect(staleClients.length).toBe(0);

      const staleCodes = await sql`
        SELECT code_hash FROM oauth_authorization_codes
        WHERE code_hash = ${staleCodeHash}
      `;
      expect(staleCodes.length).toBe(0);

      const blockedClientRows = await sql`
        SELECT client_id FROM oauth_dcr_clients
        WHERE client_name = 'Capacity ChatGPT'
      `;
      expect(blockedClientRows.length).toBe(0);

      await sql`
        DELETE FROM oauth_dcr_clients
        WHERE client_id = 'pending-cap-0'
      `;

      const afterRoom = await register('Capacity ChatGPT');
      expect(afterRoom.status).toBe(201);
      const createdClientRows = await sql`
        SELECT client_id FROM oauth_dcr_clients
        WHERE client_name = 'Capacity ChatGPT'
      `;
      expect(createdClientRows.length).toBe(1);
    } finally {
      await sql`
        DELETE FROM oauth_dcr_clients
        WHERE client_id LIKE ${'pending-cap-%'}
           OR client_id = 'stale-pending-client'
           OR client_name = 'Capacity ChatGPT'
      `;
      await sql.end();
      await engine.disconnect();
    }
  });
});
