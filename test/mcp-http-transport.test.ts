import { describe, expect, test } from 'bun:test';
import { createHash, createHash as sha256 } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { resolveConfig } from '../src/core/config.ts';
import { createMcpHttpHandler } from '../src/mcp/http-server.ts';
import { createInMemoryMcpOAuthStore } from '../src/mcp/oauth.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { DEFAULT_RUNTIME_CONFIG } from '../src/core/engine-factory.ts';
import { OperationError, type Operation } from '../src/core/operations.ts';

describe('MCP HTTP transport', () => {
  test('rejects /mcp requests without bearer auth', async () => {
    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: DEFAULT_RUNTIME_CONFIG,
      authenticate: async () => ({ ok: false, status: 401, body: { error: 'missing_auth' } }),
      logRequest: async () => {},
    });

    const response = await handler(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'missing_auth' });
  });

  test('serves health without requiring auth', async () => {
    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: DEFAULT_RUNTIME_CONFIG,
      authenticate: async () => ({ ok: false, status: 401, body: { error: 'missing_auth' } }),
      logRequest: async () => {},
    });

    const response = await handler(new Request('http://localhost/health'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      transport: 'http',
    });
  });

  test('health response does not expose internal brain metrics unauthenticated', async () => {
    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: DEFAULT_RUNTIME_CONFIG,
      authenticate: async () => ({ ok: false, status: 401, body: { error: 'missing_auth' } }),
      logRequest: async () => {},
    });

    const response = await handler(new Request('http://localhost/health'));
    const payload = await response.json();

    expect(payload).toEqual({ status: 'ok', transport: 'http' });
    expect(payload).not.toHaveProperty('version');
    expect(payload).not.toHaveProperty('checks');
  });

  test('handles initialize, tools/list, and tools/call over authenticated HTTP', async () => {
    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: DEFAULT_RUNTIME_CONFIG,
      authenticate: async (request) => {
        return request.headers.get('Authorization') === 'Bearer test-token'
          ? { ok: true, tokenName: 'test-client' }
          : { ok: false, status: 401, body: { error: 'invalid_token' } };
      },
      logRequest: async () => {},
    });

    const initialize = await postMcp(handler, {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'mbrain-http-test', version: '1.0.0' },
      },
      id: 1,
    });
    expect(initialize.status).toBe(200);

    const toolsList = await readJsonRpcResponse(await postMcp(handler, {
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
      id: 2,
    }));
    expect(toolsList.result.tools.some((tool: { name: string }) => tool.name === 'get_stats')).toBe(true);
    const getStatsTool = toolsList.result.tools.find((tool: { name: string }) => tool.name === 'get_stats');
    expect(getStatsTool.title).toBe('Get Stats');
    expect(getStatsTool.description).toContain('Brain statistics');
    expect(getStatsTool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });

    const resourcesList = await readJsonRpcResponse(await postMcp(handler, {
      jsonrpc: '2.0',
      method: 'resources/list',
      params: {},
      id: 4,
    }));
    expect(resourcesList.result.resources).toEqual([]);

    const stats = await readJsonRpcResponse(await postMcp(handler, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'get_stats', arguments: {} },
      id: 5,
    }));
    expect(stats.result.content[0].text).toContain('"pages":3');
  });

  test('default bearer auth validates SQLite access_tokens and records last use', async () => {
    const { db, dbPath } = createSqliteTokenDb();
    const token = 'mbrain_test_token';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    db.query('INSERT INTO access_tokens (id, name, token_hash) VALUES (?, ?, ?)').run('token-1', 'sqlite-client', tokenHash);
    db.close();

    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: resolveConfig({ engine: 'sqlite', database_path: dbPath }),
    });

    const response = await handler(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }),
    }));

    expect(response.status).toBe(200);
    const inspectDb = new Database(dbPath);
    const row = inspectDb.query('SELECT last_used_at FROM access_tokens WHERE token_hash = ?').get(tokenHash) as { last_used_at: string | null };
    const log = inspectDb.query('SELECT token_name, operation, status FROM mcp_request_log').get() as {
      token_name: string;
      operation: string;
      status: string;
    };
    inspectDb.close();
    expect(row.last_used_at).toEqual(expect.any(String));
    expect(log).toEqual({
      token_name: 'sqlite-client',
      operation: 'tools/list',
      status: 'success',
    });
  });

  test('default bearer auth accepts case-insensitive bearer scheme', async () => {
    const { db, dbPath } = createSqliteTokenDb();
    const token = 'mbrain_lowercase_bearer_token';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    db.query('INSERT INTO access_tokens (id, name, token_hash) VALUES (?, ?, ?)').run('token-1', 'sqlite-client', tokenHash);
    db.close();

    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: resolveConfig({ engine: 'sqlite', database_path: dbPath }),
    });

    const response = await handler(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `bearer ${token}`,
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }),
    }));

    expect(response.status).toBe(200);
  });

  test('rejects oversized MCP request bodies before authentication', async () => {
    let authCalls = 0;
    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: DEFAULT_RUNTIME_CONFIG,
      authenticate: async () => {
        authCalls++;
        return { ok: true, tokenName: 'test-client' };
      },
      logRequest: async () => {},
    });

    const response = await handler(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
        'Content-Length': String(1_048_577),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }),
    }));

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'request_too_large' });
    expect(authCalls).toBe(0);
  });

  test('rejects oversized streamed MCP request bodies before authentication', async () => {
    let authCalls = 0;
    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: DEFAULT_RUNTIME_CONFIG,
      authenticate: async () => {
        authCalls++;
        return { ok: true, tokenName: 'test-client' };
      },
      logRequest: async () => {},
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577));
        controller.close();
      },
    });

    const response = await handler(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }));

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'request_too_large' });
    expect(authCalls).toBe(0);
  });

  test('default bearer auth rejects revoked SQLite access tokens', async () => {
    const { db, dbPath } = createSqliteTokenDb();
    const tokenHash = createHash('sha256').update('revoked-token').digest('hex');
    db.query('INSERT INTO access_tokens (id, name, token_hash, revoked_at) VALUES (?, ?, ?, ?)').run(
      'token-1',
      'sqlite-client',
      tokenHash,
      '2026-01-01T00:00:00.000Z',
    );
    db.close();

    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: resolveConfig({ engine: 'sqlite', database_path: dbPath }),
    });

    const response = await handler(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer revoked-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }),
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'token_revoked' });
  });

  test('shares the MCP execution limiter across concurrent HTTP requests', async () => {
    let active = 0;
    let maxActive = 0;
    const slowMutatingOp: Operation = {
      name: 'slow_mutation',
      description: 'Test-only slow mutating operation.',
      params: {},
      mutating: true,
      handler: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          await sleep(20);
          return { ok: true };
        } finally {
          active--;
        }
      },
    };
    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: DEFAULT_RUNTIME_CONFIG,
      operations: [slowMutatingOp],
      authenticate: async () => ({ ok: true, tokenName: 'test-client' }),
      logRequest: async () => {},
    });

    await Promise.all([
      postMcp(handler, { jsonrpc: '2.0', method: 'tools/call', params: { name: 'slow_mutation', arguments: {} }, id: 1 }).then(readJsonRpcResponse),
      postMcp(handler, { jsonrpc: '2.0', method: 'tools/call', params: { name: 'slow_mutation', arguments: {} }, id: 2 }).then(readJsonRpcResponse),
    ]);

    expect(maxActive).toBe(1);
  });

  test('logs tool errors as error status with the tool name', async () => {
    const logs: Array<{ operation: string; status: string }> = [];
    const failingOp: Operation = {
      name: 'failing_tool',
      description: 'Test-only failing operation.',
      params: {},
      handler: async () => {
        throw new OperationError('invalid_params', 'nope');
      },
    };
    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: DEFAULT_RUNTIME_CONFIG,
      operations: [failingOp],
      authenticate: async () => ({ ok: true, tokenName: 'test-client' }),
      logRequest: async (entry) => {
        logs.push({ operation: entry.operation, status: entry.status });
      },
    });

    const response = await readJsonRpcResponse(await postMcp(handler, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'failing_tool', arguments: {} },
      id: 1,
    }));

    expect(response.result.isError).toBe(true);
    expect(logs).toEqual([{ operation: 'failing_tool', status: 'error' }]);
  });

  test('serves OAuth metadata and dynamic client registration when enabled', async () => {
    const { dbPath } = createSqliteTokenDb();
    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: resolveConfig({ engine: 'sqlite', database_path: dbPath }),
      oauthStore: createInMemoryMcpOAuthStore(),
      oauth: {
        enabled: true,
        publicBaseUrl: 'https://brain.example.com',
        approvalToken: 'owner-secret',
        signingSecret: 'test-signing-secret',
      },
    });

    const metadata = await handler(new Request('http://localhost/.well-known/oauth-authorization-server'));
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      issuer: 'https://brain.example.com',
      authorization_endpoint: 'https://brain.example.com/oauth/authorize',
      token_endpoint: 'https://brain.example.com/oauth/token',
      registration_endpoint: 'https://brain.example.com/oauth/register',
      code_challenge_methods_supported: ['S256'],
    });

    const protectedResource = await handler(new Request('http://localhost/.well-known/oauth-protected-resource'));
    expect(protectedResource.status).toBe(200);
    expect(await protectedResource.json()).toMatchObject({
      resource: 'https://brain.example.com/mcp',
      authorization_servers: ['https://brain.example.com'],
    });

    const register = await handler(new Request('http://localhost/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        redirect_uris: ['https://chat.openai.com/aip/callback'],
        token_endpoint_auth_method: 'none',
      }),
    }));
    expect(register.status).toBe(201);
    const registration = await register.json() as { client_id: string; redirect_uris: string[] };
    expect(registration.client_id).toStartWith('mbrain_dcr_');
    expect(registration.redirect_uris).toEqual(['https://chat.openai.com/aip/callback']);
  });

  test('OAuth authorization code exchange mints an MCP bearer token with PKCE', async () => {
    const { dbPath } = createSqliteTokenDb();
    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: resolveConfig({ engine: 'sqlite', database_path: dbPath }),
      oauthStore: createInMemoryMcpOAuthStore(),
      oauth: {
        enabled: true,
        publicBaseUrl: 'https://brain.example.com',
        approvalToken: 'owner-secret',
        signingSecret: 'test-signing-secret',
      },
    });
    const redirectUri = 'https://chat.openai.com/aip/callback';
    const client = await registerOAuthClient(handler, redirectUri);
    const verifier = 'test-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
    const challenge = sha256('sha256').update(verifier).digest('base64url');

    const authorize = await handler(new Request('http://localhost/oauth/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        approval_token: 'owner-secret',
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        state: 'opaque-state',
        scope: 'mcp',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    }));

    expect(authorize.status).toBe(302);
    const redirect = new URL(authorize.headers.get('Location')!);
    expect(redirect.origin + redirect.pathname).toBe(redirectUri);
    expect(redirect.searchParams.get('state')).toBe('opaque-state');
    const code = redirect.searchParams.get('code');
    expect(code).toEqual(expect.any(String));

    const token = await handler(new Request('http://localhost/oauth/token', {
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
    const payload = await token.json() as { access_token: string; token_type: string; expires_in: number; refresh_token: string };
    expect(payload.access_token).toStartWith('mbrain_');
    expect(payload.token_type).toBe('Bearer');
    expect(payload.expires_in).toBeGreaterThan(0);
    expect(payload.refresh_token).toStartWith('mbrain_refresh_');

    const tools = await handler(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${payload.access_token}`,
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }),
    }));
    expect(tools.status).toBe(200);

    const inspectDb = new Database(dbPath);
    const tokenHash = createHash('sha256').update(payload.access_token).digest('hex');
    const row = inspectDb
      .query('SELECT name, scopes, last_used_at FROM access_tokens WHERE token_hash = ?')
      .get(tokenHash) as { name: string; scopes: string; last_used_at: string | null };
    inspectDb.close();
    expect(row.name).toBe('oauth:ChatGPT');
    expect(JSON.parse(row.scopes)).toContain('mcp');
    expect(row.last_used_at).toEqual(expect.any(String));
  });

  test('OAuth refresh rotates access tokens and rejects the previous access token', async () => {
    const { dbPath } = createSqliteTokenDb();
    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: resolveConfig({ engine: 'sqlite', database_path: dbPath }),
      oauthStore: createInMemoryMcpOAuthStore(),
      oauth: {
        enabled: true,
        publicBaseUrl: 'https://brain.example.com',
        approvalToken: 'owner-secret',
        signingSecret: 'test-signing-secret',
      },
    });
    const redirectUri = 'https://chat.openai.com/aip/callback';
    const client = await registerOAuthClient(handler, redirectUri);
    const verifier = 'test-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
    const challenge = sha256('sha256').update(verifier).digest('base64url');

    const authorize = await handler(new Request('http://localhost/oauth/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        approval_token: 'owner-secret',
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        scope: 'mcp',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    }));
    const code = new URL(authorize.headers.get('Location')!).searchParams.get('code')!;

    const token = await handler(new Request('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
    }));
    expect(token.status).toBe(200);
    const payload = await token.json() as { access_token: string; refresh_token: string };

    const refresh = await handler(new Request('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: payload.refresh_token,
      }),
    }));
    expect(refresh.status).toBe(200);
    const refreshed = await refresh.json() as { access_token: string };
    expect(refreshed.access_token).not.toBe(payload.access_token);

    const oldTokenResponse = await handler(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${payload.access_token}`,
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }),
    }));
    expect(oldTokenResponse.status).toBe(401);
    expect(oldTokenResponse.headers.get('WWW-Authenticate')).toContain('/.well-known/oauth-protected-resource');
    expect(await oldTokenResponse.json()).toMatchObject({ error: 'invalid_token' });

    const refreshedTokenResponse = await handler(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${refreshed.access_token}`,
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 2 }),
    }));
    expect(refreshedTokenResponse.status).toBe(200);

    const inspectDb = new Database(dbPath);
    const rows = inspectDb
      .query('SELECT revoked_at FROM access_tokens WHERE name = ? ORDER BY created_at')
      .all('oauth:ChatGPT') as { revoked_at: string | null }[];
    inspectDb.close();
    expect(rows).toHaveLength(2);
    expect(rows.filter(row => row.revoked_at !== null)).toHaveLength(1);
    expect(rows.filter(row => row.revoked_at === null)).toHaveLength(1);
  });

  test('OAuth rotation does not revoke independent same-name client sessions', async () => {
    const { dbPath } = createSqliteTokenDb();
    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: resolveConfig({ engine: 'sqlite', database_path: dbPath }),
      oauthStore: createInMemoryMcpOAuthStore(),
      oauth: {
        enabled: true,
        publicBaseUrl: 'https://brain.example.com',
        approvalToken: 'owner-secret',
        signingSecret: 'test-signing-secret',
      },
    });
    const redirectUri = 'https://chat.openai.com/aip/callback';
    const firstClient = await registerOAuthClient(handler, redirectUri);
    const secondClient = await registerOAuthClient(handler, redirectUri);
    const first = await authorizeOAuthClient(handler, firstClient.client_id, redirectUri);
    const second = await authorizeOAuthClient(handler, secondClient.client_id, redirectUri);

    expect(await postOAuthMcp(handler, first.accessToken, 1).then(response => response.status)).toBe(200);
    expect(await postOAuthMcp(handler, second.accessToken, 2).then(response => response.status)).toBe(200);

    const refreshedFirst = await refreshOAuthClient(handler, firstClient.client_id, first.refreshToken);

    expect(await postOAuthMcp(handler, first.accessToken, 3).then(response => response.status)).toBe(401);
    expect(await postOAuthMcp(handler, refreshedFirst.accessToken, 4).then(response => response.status)).toBe(200);
    expect(await postOAuthMcp(handler, second.accessToken, 5).then(response => response.status)).toBe(200);
  });

  test('OAuth repeated refreshes do not revoke freshly returned access tokens', async () => {
    const { dbPath } = createSqliteTokenDb();
    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: resolveConfig({ engine: 'sqlite', database_path: dbPath }),
      oauthStore: createInMemoryMcpOAuthStore(),
      oauth: {
        enabled: true,
        publicBaseUrl: 'https://brain.example.com',
        approvalToken: 'owner-secret',
        signingSecret: 'test-signing-secret',
      },
    });
    const redirectUri = 'https://chat.openai.com/aip/callback';
    const client = await registerOAuthClient(handler, redirectUri);
    const initial = await authorizeOAuthClient(handler, client.client_id, redirectUri);
    const firstRefresh = await refreshOAuthClient(handler, client.client_id, initial.refreshToken);
    const secondRefresh = await refreshOAuthClient(handler, client.client_id, initial.refreshToken);

    expect(await postOAuthMcp(handler, initial.accessToken, 1).then(response => response.status)).toBe(401);
    expect(await postOAuthMcp(handler, firstRefresh.accessToken, 2).then(response => response.status)).toBe(200);
    expect(await postOAuthMcp(handler, secondRefresh.accessToken, 3).then(response => response.status)).toBe(200);
  });

  test('OAuth token endpoint rejects reused codes and bad PKCE verifiers', async () => {
    const { dbPath } = createSqliteTokenDb();
    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: resolveConfig({ engine: 'sqlite', database_path: dbPath }),
      oauthStore: createInMemoryMcpOAuthStore(),
      oauth: {
        enabled: true,
        publicBaseUrl: 'https://brain.example.com',
        approvalToken: 'owner-secret',
        signingSecret: 'test-signing-secret',
      },
    });
    const redirectUri = 'https://chat.openai.com/aip/callback';
    const client = await registerOAuthClient(handler, redirectUri);
    const verifier = 'test-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
    const challenge = sha256('sha256').update(verifier).digest('base64url');
    const authorize = await handler(new Request('http://localhost/oauth/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        approval_token: 'owner-secret',
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    }));
    const code = new URL(authorize.headers.get('Location')!).searchParams.get('code')!;

    const badVerifier = await handler(new Request('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code,
        code_verifier: 'wrong-verifier',
      }),
    }));
    expect(badVerifier.status).toBe(400);
    expect(await badVerifier.json()).toMatchObject({ error: 'invalid_grant' });

    const firstExchange = await handler(new Request('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
    }));
    expect(firstExchange.status).toBe(200);

    const secondExchange = await handler(new Request('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
    }));
    expect(secondExchange.status).toBe(400);
    expect(await secondExchange.json()).toMatchObject({ error: 'invalid_grant' });
  });

  test('OAuth authorization codes are single-use under concurrent exchange attempts', async () => {
    const { dbPath } = createSqliteTokenDb();
    const handler = createMcpHttpHandler({
      engine: createStatsEngine(),
      config: resolveConfig({ engine: 'sqlite', database_path: dbPath }),
      oauthStore: createInMemoryMcpOAuthStore(),
      oauth: {
        enabled: true,
        publicBaseUrl: 'https://brain.example.com',
        approvalToken: 'owner-secret',
        signingSecret: 'test-signing-secret',
      },
    });
    const redirectUri = 'https://chat.openai.com/aip/callback';
    const client = await registerOAuthClient(handler, redirectUri);
    const verifier = 'test-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
    const challenge = sha256('sha256').update(verifier).digest('base64url');
    const authorize = await handler(new Request('http://localhost/oauth/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        approval_token: 'owner-secret',
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    }));
    const code = new URL(authorize.headers.get('Location')!).searchParams.get('code')!;

    const tokenBody = () => new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    });
    const exchanges = await Promise.all([
      handler(new Request('http://localhost/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody(),
      })),
      handler(new Request('http://localhost/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody(),
      })),
    ]);

    expect(exchanges.map(response => response.status).sort()).toEqual([200, 400]);
    const failed = exchanges.find(response => response.status === 400)!;
    expect(await failed.json()).toMatchObject({ error: 'invalid_grant' });
  });

  test('HTTP OAuth requires Postgres setup state unless an explicit test store is injected', () => {
    const { dbPath } = createSqliteTokenDb();

    expect(() => createMcpHttpHandler({
      engine: createStatsEngine(),
      config: resolveConfig({ engine: 'sqlite', database_path: dbPath }),
      oauth: {
        enabled: true,
        publicBaseUrl: 'https://brain.example.com',
        approvalToken: 'owner-secret',
        signingSecret: 'test-signing-secret',
      },
    })).toThrow('HTTP OAuth setup state requires the Postgres engine');
  });
});

async function postMcp(
  handler: (request: Request) => Promise<Response>,
  body: Record<string, unknown>,
): Promise<Response> {
  return handler(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  }));
}

async function readJsonRpcResponse(response: Response): Promise<any> {
  expect(response.status).toBe(200);
  const text = await response.text();
  if (text.includes('event:')) {
    const dataLine = text.split('\n').find(line => line.startsWith('data:'));
    if (!dataLine) throw new Error(`No SSE data line in response: ${text}`);
    return JSON.parse(dataLine.slice('data:'.length).trim());
  }
  return JSON.parse(text);
}

async function registerOAuthClient(
  handler: (request: Request) => Promise<Response>,
  redirectUri: string,
): Promise<{ client_id: string }> {
  const response = await handler(new Request('http://localhost/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    }),
  }));
  expect(response.status).toBe(201);
  return response.json() as Promise<{ client_id: string }>;
}

async function authorizeOAuthClient(
  handler: (request: Request) => Promise<Response>,
  clientId: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const verifier = 'test-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
  const challenge = sha256('sha256').update(verifier).digest('base64url');
  const authorize = await handler(new Request('http://localhost/oauth/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      approval_token: 'owner-secret',
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'mcp',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }),
  }));
  expect(authorize.status).toBe(302);
  const code = new URL(authorize.headers.get('Location')!).searchParams.get('code')!;
  const token = await handler(new Request('http://localhost/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }),
  }));
  expect(token.status).toBe(200);
  const payload = await token.json() as { access_token: string; refresh_token: string };
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
  };
}

async function refreshOAuthClient(
  handler: (request: Request) => Promise<Response>,
  clientId: string,
  refreshToken: string,
): Promise<{ accessToken: string }> {
  const refresh = await handler(new Request('http://localhost/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    }),
  }));
  expect(refresh.status).toBe(200);
  const payload = await refresh.json() as { access_token: string };
  return { accessToken: payload.access_token };
}

async function postOAuthMcp(
  handler: (request: Request) => Promise<Response>,
  accessToken: string,
  id: number,
): Promise<Response> {
  return handler(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id }),
  }));
}

function createStatsEngine(): BrainEngine {
  return {
    getStats: async () => ({
      pages: 3,
      links: 2,
      tags: 1,
      chunks: 4,
      files: 0,
      timeline_entries: 0,
      raw_data_entries: 0,
      page_embeddings: 0,
      chunk_embeddings: 0,
    }),
    getHealth: async () => ({
      page_count: 3,
      embed_coverage: 1,
      stale_pages: 0,
      orphan_pages: 0,
      dead_links: 0,
      missing_embeddings: 0,
    }),
  } as unknown as BrainEngine;
}

function createSqliteTokenDb(): { db: Database; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-http-auth-'));
  const dbPath = join(dir, 'brain.db');
  const db = new Database(dbPath);
  db.run(`
    CREATE TABLE access_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_used_at TEXT,
      revoked_at TEXT
    )
  `);
  db.run(`
    CREATE TABLE mcp_request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_name TEXT,
      operation TEXT NOT NULL,
      latency_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'success',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  return { db, dbPath };
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}
