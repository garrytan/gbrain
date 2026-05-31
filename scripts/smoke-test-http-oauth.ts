#!/usr/bin/env bun
import { createHash } from 'crypto';
import postgres from 'postgres';
import { resolveConfig } from '../src/core/config.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { startMcpHttpServer } from '../src/mcp/http-server.ts';

export interface HttpOAuthSmokeOptions {
  databaseUrl?: string;
  host?: string;
  port?: number;
  publicBaseUrl?: string;
  approvalToken?: string;
  signingSecret?: string;
  cleanup?: boolean;
  verbose?: boolean;
}

export interface HttpOAuthSmokeResult {
  baseUrl: string;
  oauthIssuer: string;
  accessTokenRows: number;
  requestLogRows: number;
  logOperations: string[];
  refreshedTokenWorked: boolean;
  initialTokenRejectedAfterRefresh: boolean;
}

const CLIENT_NAME = 'MBrain OAuth Smoke';
const TOKEN_NAME = `oauth:${CLIENT_NAME}`;
const REDIRECT_URI = 'https://chat.openai.com/aip/callback';
const CODE_VERIFIER = 'mbrain-oauth-smoke-verifier-abcdefghijklmnopqrstuvwxyz0123456789';

export async function runHttpOAuthSmoke(options: HttpOAuthSmokeOptions = {}): Promise<HttpOAuthSmokeResult> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? process.env.MBRAIN_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Set DATABASE_URL or MBRAIN_DATABASE_URL before running the HTTP OAuth smoke.');
  }

  const approvalToken = options.approvalToken
    ?? process.env.MBRAIN_OAUTH_APPROVAL_TOKEN
    ?? 'mbrain-oauth-smoke-owner-token';
  const signingSecret = options.signingSecret
    ?? process.env.MBRAIN_OAUTH_SIGNING_SECRET
    ?? 'mbrain-oauth-smoke-signing-secret';
  const host = options.host ?? process.env.MBRAIN_HTTP_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.MBRAIN_HTTP_PORT ?? 0);
  const publicBaseUrl = normalizePublicBaseUrl(options.publicBaseUrl ?? process.env.MBRAIN_HTTP_PUBLIC_URL);
  const cleanup = options.cleanup ?? true;
  const verbose = options.verbose ?? process.env.MBRAIN_SMOKE_VERBOSE === '1';
  const config = resolveConfig({
    engine: 'postgres',
    database_url: databaseUrl,
    offline: false,
    embedding_provider: 'none',
    query_rewrite_provider: 'none',
  });

  const engine = new PostgresEngine();
  const onnotice = createSmokeNoticeHandler(verbose);
  const schemaLogger = createSmokeSchemaLogger(verbose);
  const sql = postgres(databaseUrl, { max: 1, onnotice });
  let server: ReturnType<typeof startMcpHttpServer> | null = null;

  try {
    await engine.connect({ database_url: databaseUrl, onnotice, schemaLogger });
    await engine.initSchema();
    await deleteSmokeEvidence(sql);

    server = startMcpHttpServer({
      engine,
      config,
      host,
      port,
      oauth: {
        enabled: true,
        publicBaseUrl,
        approvalToken,
        signingSecret,
      },
    });
    const baseUrl = `http://${server.hostname}:${server.port}`;
    const oauthIssuer = publicBaseUrl ?? baseUrl;

    await assertProtectedResourceChallenge(baseUrl, oauthIssuer);
    await assertMetadata(baseUrl, oauthIssuer);
    const clientId = await registerClient(baseUrl);
    const { accessToken, refreshToken } = await authorizeAndExchange(baseUrl, {
      clientId,
      approvalToken,
    });

    await callMcp(baseUrl, accessToken, {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'mbrain-http-oauth-smoke', version: '1.0.0' },
      },
      id: 1,
    });
    const toolsList = await callMcp(baseUrl, accessToken, {
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
      id: 2,
    });
    if (!toolsList.result?.tools?.some((tool: { name?: string }) => tool.name === 'get_stats')) {
      throw new Error(`tools/list did not expose get_stats: ${JSON.stringify(toolsList)}`);
    }

    const stats = await callMcp(baseUrl, accessToken, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'get_stats', arguments: {} },
      id: 3,
    });
    const statsText = stats.result?.content?.find((entry: { type?: string }) => entry.type === 'text')?.text;
    if (typeof statsText !== 'string' || !statsText.includes('page_count')) {
      throw new Error(`get_stats did not return a stats payload: ${JSON.stringify(stats)}`);
    }

    const refreshedAccessToken = await refreshAccessToken(baseUrl, clientId, refreshToken);
    const refreshedToolsList = await callMcp(baseUrl, refreshedAccessToken, {
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
      id: 4,
    });
    const refreshedTokenWorked = refreshedToolsList.result?.tools?.some((tool: { name?: string }) => tool.name === 'get_stats') === true;
    if (!refreshedTokenWorked) {
      throw new Error(`refreshed access token did not work: ${JSON.stringify(refreshedToolsList)}`);
    }
    const initialTokenAfterRefresh = await callMcpRaw(baseUrl, accessToken, {
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
      id: 5,
    });
    const initialTokenRejectedAfterRefresh = initialTokenAfterRefresh.status === 401;
    const initialTokenRejectionBody = safeJson(initialTokenAfterRefresh.body);
    if (!initialTokenRejectedAfterRefresh || initialTokenRejectionBody?.error !== 'invalid_token') {
      throw new Error(
        `initial access token still worked after refresh: status=${initialTokenAfterRefresh.status} body=${initialTokenAfterRefresh.body}`,
      );
    }

    const accessTokens = await sql`
      SELECT scopes, last_used_at, revoked_at FROM access_tokens
      WHERE name = ${TOKEN_NAME}
      ORDER BY created_at
    `;
    if (accessTokens.length < 2) {
      throw new Error(`Expected at least 2 OAuth access token rows, found ${accessTokens.length}`);
    }
    const logs = await sql`
      SELECT operation FROM mcp_request_log
      WHERE token_name = ${TOKEN_NAME}
      ORDER BY created_at
    `;

    return {
      baseUrl,
      oauthIssuer,
      accessTokenRows: accessTokens.length,
      requestLogRows: logs.length,
      logOperations: logs.map(row => String(row.operation)),
      refreshedTokenWorked,
      initialTokenRejectedAfterRefresh,
    };
  } finally {
    if (server) {
      server.stop(true);
    }
    if (cleanup) {
      await deleteSmokeEvidence(sql).catch(() => undefined);
    }
    await sql.end();
    await engine.disconnect();
  }
}

async function assertProtectedResourceChallenge(baseUrl: string, oauthIssuer: string): Promise<void> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }),
  });
  if (response.status !== 401) {
    throw new Error(`Expected unauthenticated /mcp to return 401, got ${response.status}`);
  }
  const challenge = response.headers.get('WWW-Authenticate') ?? '';
  const resourceMetadata = parseWwwAuthenticateParam(challenge, 'resource_metadata');
  if (resourceMetadata !== `${oauthIssuer}/.well-known/oauth-protected-resource`) {
    throw new Error(`WWW-Authenticate did not advertise protected-resource metadata: ${challenge}`);
  }
}

async function assertMetadata(baseUrl: string, oauthIssuer: string): Promise<void> {
  const authServer = await getJson(`${baseUrl}/.well-known/oauth-authorization-server`);
  assertEqual(authServer.issuer, oauthIssuer, 'issuer');
  assertEqual(authServer.authorization_endpoint, `${oauthIssuer}/oauth/authorize`, 'authorization_endpoint');
  assertEqual(authServer.token_endpoint, `${oauthIssuer}/oauth/token`, 'token_endpoint');
  assertEqual(authServer.registration_endpoint, `${oauthIssuer}/oauth/register`, 'registration_endpoint');

  const protectedResource = await getJson(`${baseUrl}/.well-known/oauth-protected-resource`);
  assertEqual(protectedResource.resource, `${oauthIssuer}/mcp`, 'resource');
  if (!Array.isArray(protectedResource.authorization_servers) || protectedResource.authorization_servers[0] !== oauthIssuer) {
    throw new Error(`Unexpected authorization_servers: ${JSON.stringify(protectedResource.authorization_servers)}`);
  }
}

async function registerClient(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
    }),
  });
  const body = await response.json() as { client_id?: string };
  if (response.status !== 201 || !body.client_id) {
    throw new Error(`Client registration failed: status=${response.status} body=${JSON.stringify(body)}`);
  }
  return body.client_id;
}

async function authorizeAndExchange(
  baseUrl: string,
  input: { clientId: string; approvalToken: string },
): Promise<{ accessToken: string; refreshToken: string }> {
  const challenge = createHash('sha256').update(CODE_VERIFIER).digest('base64url');
  const authorize = await fetch(`${baseUrl}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      approval_token: input.approvalToken,
      response_type: 'code',
      client_id: input.clientId,
      redirect_uri: REDIRECT_URI,
      state: 'mbrain-smoke-state',
      scope: 'mcp',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }),
  });
  if (authorize.status !== 302) {
    throw new Error(`Authorization failed: status=${authorize.status} body=${await authorize.text()}`);
  }
  const redirect = new URL(authorize.headers.get('Location') ?? '');
  if (redirect.searchParams.get('state') !== 'mbrain-smoke-state') {
    throw new Error(`Authorization state was not preserved: ${redirect.toString()}`);
  }
  const code = redirect.searchParams.get('code');
  if (!code) throw new Error(`Authorization redirect did not include code: ${redirect.toString()}`);

  const token = await postForm(`${baseUrl}/oauth/token`, {
    grant_type: 'authorization_code',
    client_id: input.clientId,
    redirect_uri: REDIRECT_URI,
    code,
    code_verifier: CODE_VERIFIER,
  });
  if (typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string') {
    throw new Error(`Token response was missing access or refresh token: ${JSON.stringify(token)}`);
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
  };
}

async function refreshAccessToken(baseUrl: string, clientId: string, refreshToken: string): Promise<string> {
  const token = await postForm(`${baseUrl}/oauth/token`, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });
  if (typeof token.access_token !== 'string') {
    throw new Error(`Refresh response was missing access_token: ${JSON.stringify(token)}`);
  }
  return token.access_token;
}

async function callMcp(baseUrl: string, accessToken: string, body: Record<string, unknown>): Promise<any> {
  const response = await callMcpRaw(baseUrl, accessToken, body);
  if (response.status !== 200) {
    throw new Error(`MCP request failed: status=${response.status} body=${response.body}`);
  }
  return readJsonRpcText(response.body);
}

async function callMcpRaw(
  baseUrl: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.text(),
  };
}

function readJsonRpcText(text: string): any {
  if (text.includes('event:')) {
    const dataLine = text.split('\n').find(line => line.startsWith('data:'));
    if (!dataLine) throw new Error(`No SSE data line in response: ${text}`);
    return JSON.parse(dataLine.slice('data:'.length).trim());
  }
  return JSON.parse(text);
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  const body = await response.json() as Record<string, unknown>;
  if (response.status !== 200) {
    throw new Error(`GET ${url} failed: status=${response.status} body=${JSON.stringify(body)}`);
  }
  return body;
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, string>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const payload = await response.json() as Record<string, string>;
  if (response.status !== 200) {
    throw new Error(`POST ${url} failed: status=${response.status} body=${JSON.stringify(payload)}`);
  }
  return payload;
}

function assertEqual(actual: unknown, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`Unexpected ${label}: expected=${expected} actual=${String(actual)}`);
  }
}

function normalizePublicBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Explicit public OAuth issuer must be an HTTPS URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Explicit public OAuth issuer must be an HTTPS URL.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Explicit public OAuth issuer must not include username or password.');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function parseWwwAuthenticateParam(header: string, paramName: string): string | null {
  const pattern = new RegExp(`(?:^|[\\s,])${paramName}="([^"]*)"`);
  return header.match(pattern)?.[1] ?? null;
}

async function deleteSmokeEvidence(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`
    DELETE FROM mcp_request_log
    WHERE token_name = ${TOKEN_NAME}
  `;
  await sql`
    DELETE FROM access_tokens
    WHERE name = ${TOKEN_NAME}
  `;
}

function createSmokeNoticeHandler(verbose: boolean): (notice: postgres.Notice) => void {
  return (notice) => {
    if (notice.severity === 'NOTICE') {
      if (verbose) console.log(notice);
      return;
    }

    console.warn(notice);
  };
}

function createSmokeSchemaLogger(verbose: boolean): (message: string) => void {
  return (message) => {
    if (verbose) console.log(message);
  };
}

async function main(): Promise<void> {
  const result = await runHttpOAuthSmoke();
  console.log(JSON.stringify({
    ok: true,
    ...result,
  }, null, 2));
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
