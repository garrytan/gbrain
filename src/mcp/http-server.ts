import { createHash, randomBytes, randomUUID } from 'crypto';
import { Database } from 'bun:sqlite';
import postgres from 'postgres';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { BrainEngine } from '../core/engine.ts';
import type { MBrainConfig } from '../core/config.ts';
import type { Operation } from '../core/operations.ts';
import { createTokenAuthPrincipal, serializeAuthPrincipal, type OperationAuthPrincipal } from '../core/auth-principal.ts';
import { createMcpServer, createMcpToolExecutionLimiter } from './server.ts';
import {
  surfaceTokenCapabilitiesFromScopes,
  type McpSurfaceProfileName,
} from './surface-profile.ts';
import {
  createMcpOAuthState,
  handleMcpOAuthRequest,
  isMcpOAuthPath,
  OAuthRefreshTokenReplayError,
  OAuthStoreCapacityError,
  oauthResourceMetadataHeader,
  type McpOAuthStore,
  type McpOAuthAccessTokenInput,
  type McpOAuthOptions,
  type OAuthAuthorizationCodeRecord,
  type OAuthClientRecord,
} from './oauth.ts';

const MAX_MCP_HTTP_BODY_BYTES = 1_048_576;
const MAX_PENDING_OAUTH_DCR_CLIENTS = 128;
const PENDING_OAUTH_DCR_CLIENT_TTL_SECONDS = 60 * 60;
const OAUTH_AUTHORIZATION_CODE_RETENTION_SECONDS = 60 * 60;

export interface McpHttpAuthSuccess {
  ok: true;
  tokenId?: string;
  tokenName: string;
  scopes?: string[];
}

export interface McpHttpAuthFailure {
  ok: false;
  status: number;
  body: Record<string, unknown>;
}

export type McpHttpAuthResult = McpHttpAuthSuccess | McpHttpAuthFailure;

export interface McpHttpHandlerOptions {
  engine: BrainEngine | Promise<BrainEngine>;
  config: MBrainConfig;
  operations?: Operation[];
  oauth?: McpOAuthOptions;
  oauthStore?: McpOAuthStore;
  authenticate?: (request: Request) => Promise<McpHttpAuthResult>;
  logRequest?: (entry: McpHttpRequestLogEntry) => Promise<void>;
  /**
   * Exact origins allowed for browser CORS. When unset or empty, no CORS
   * headers are emitted at all: non-browser MCP clients are unaffected and
   * browsers are denied by default instead of the previous wildcard.
   */
  allowedOrigins?: string[];
  surfaceProfile?: Extract<McpSurfaceProfileName, 'http_local' | 'http_remote'>;
  toolTier?: string;
}

export interface McpHttpRequestLogEntry {
  tokenName: string;
  operation: string;
  latencyMs: number;
  status: 'success' | 'error';
  errorCode?: string;
  errorReason?: string;
  surfaceProfile?: string;
  authPrincipal?: OperationAuthPrincipal;
}

export interface StartMcpHttpServerOptions extends McpHttpHandlerOptions {
  host: string;
  port: number;
}

export function createMcpHttpHandler(
  options: McpHttpHandlerOptions,
): (request: Request, clientIp?: string | null) => Promise<Response> {
  const enginePromise = Promise.resolve(options.engine);
  const authenticate = options.authenticate ?? ((request: Request) => authenticateMcpHttpRequest(options.config, request));
  const toolExecutionLimiter = createMcpToolExecutionLimiter();
  const oauthState = options.oauth?.enabled
    ? createMcpOAuthState(options.oauth, options.oauthStore ?? createMcpOAuthStore(options.config))
    : null;
  const oauthRateLimiter = createFixedWindowRateLimiter(OAUTH_ENDPOINT_RATE_LIMIT);

  return async function handleMcpHttpRequest(request: Request, clientIp?: string | null): Promise<Response> {
    const cors = corsHeadersFor(request, options.allowedOrigins);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    const response = await dispatch(request, clientIp ?? null);
    return applyExtraHeaders(response, cors);
  };

  async function dispatch(request: Request, clientIp: string | null): Promise<Response> {
    const url = new URL(request.url);

    if (oauthState && isMcpOAuthPath(url.pathname)) {
      if (isRateLimitedOAuthPath(url.pathname) && !oauthRateLimiter.allow(clientIp ?? 'global')) {
        return jsonResponse(
          { error: 'rate_limited', error_description: 'too many OAuth requests; retry later' },
          429,
          { 'Retry-After': '60' },
        );
      }
      const boundedRequest = await boundHttpRequestBody(request);
      if (!boundedRequest.ok) {
        return jsonResponse(boundedRequest.body, 413);
      }
      return handleMcpOAuthRequest({
        request: boundedRequest.request,
        state: oauthState,
        issueAccessToken: (input) => issueMcpHttpAccessToken(options.config, input),
      });
    }

    if (url.pathname === '/health') {
      return handleHealth(enginePromise);
    }

    if (url.pathname !== '/mcp') {
      return jsonResponse({ error: 'not_found' }, 404);
    }

    const boundedRequest = await boundHttpRequestBody(request);
    if (!boundedRequest.ok) {
      return jsonResponse(boundedRequest.body, 413);
    }
    request = boundedRequest.request;

    const auth = await authenticate(request);
    if (!auth.ok) {
      const headers = auth.status === 401 && options.oauth?.enabled
        ? { 'WWW-Authenticate': oauthResourceMetadataHeader(request, options.oauth) ?? '' }
        : undefined;
      return jsonResponse(auth.body, auth.status, headers);
    }

    const operation = await inferMcpHttpOperation(request);
    const startTime = Date.now();
    const surfaceProfile = options.surfaceProfile ?? 'http_remote';
    const authPrincipal = createTokenAuthPrincipal({
      tokenId: auth.tokenId,
      tokenName: auth.tokenName,
      scopes: auth.scopes,
      surfaceProfile,
    });
    const transport = new WebStandardStreamableHTTPServerTransport();
    const { server } = createMcpServer(enginePromise, {
      operations: options.operations,
      config: options.config,
      compactToolSchemas: false,
      surfaceProfile,
      toolTier: options.toolTier,
      tokenCapabilities: surfaceTokenCapabilitiesFromScopes(auth.scopes),
      authPrincipal,
      toolExecutionLimiter,
      logger: {
        info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
        warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
        error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
      },
    });
    await server.connect(transport);

    try {
      const response = await transport.handleRequest(request);
      const responseClassification = await classifyMcpHttpResponse(request, response);
      await logRequest(options, {
        tokenName: auth.tokenName,
        operation,
        latencyMs: Date.now() - startTime,
        status: responseClassification.status,
        surfaceProfile,
        authPrincipal,
        ...(responseClassification.errorCode ? { errorCode: responseClassification.errorCode } : {}),
        ...(responseClassification.errorReason ? { errorReason: responseClassification.errorReason } : {}),
      });
      return response;
    } catch (error) {
      await logRequest(options, {
        tokenName: auth.tokenName,
        operation,
        latencyMs: Date.now() - startTime,
        status: 'error',
        errorCode: 'transport_exception',
        errorReason: error instanceof Error ? error.message : String(error),
        surfaceProfile,
        authPrincipal,
      });
      throw error;
    }
  }
}

async function inferMcpHttpOperation(request: Request): Promise<string> {
  if (request.method !== 'POST') return request.method.toLowerCase();
  try {
    const body = await request.clone().json() as unknown;
    if (Array.isArray(body)) return 'batch';
    if (!isRecord(body)) return 'mcp_request';
    if (body.method === 'tools/call' && isRecord(body.params) && typeof body.params.name === 'string') {
      return body.params.name;
    }
    return typeof body.method === 'string' ? body.method : 'mcp_request';
  } catch {
    return 'mcp_request';
  }
}

type McpHttpResponseClassification = {
  status: 'success' | 'error';
  errorCode?: string;
  errorReason?: string;
};

async function classifyMcpHttpResponse(request: Request, response: Response): Promise<McpHttpResponseClassification> {
  if (response.status >= 400) return { status: 'error', errorCode: `http_${response.status}` };
  if (request.method !== 'POST') return { status: 'success' };

  try {
    const text = await response.clone().text();
    const details = extractMcpResponseErrorDetails(text);
    return details ? { status: 'error', ...details } : { status: 'success' };
  } catch {
    return { status: 'success' };
  }
}

function extractMcpResponseErrorDetails(text: string): { errorCode?: string; errorReason?: string } | null {
  const payloadTexts = extractMcpResponsePayloadTexts(text);
  if (payloadTexts.length === 0) return text.includes('"isError":true') || text.includes('"error":{') ? {} : null;
  for (const payloadText of payloadTexts) {
    const details = extractMcpResponsePayloadErrorDetails(payloadText);
    if (details) return details;
  }
  return text.includes('"isError":true') || text.includes('"error":{') ? {} : null;
}

function extractMcpResponsePayloadTexts(text: string): string[] {
  const dataLines = text
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trim())
    .filter(Boolean);
  return dataLines.length > 0 ? dataLines : [text].filter(Boolean);
}

function extractMcpResponsePayloadErrorDetails(payloadText: string): { errorCode?: string; errorReason?: string } | null {
  try {
    const payload = JSON.parse(payloadText) as unknown;
    if (Array.isArray(payload)) {
      for (const item of payload) {
        const details = extractMcpResponseObjectErrorDetails(item);
        if (details) return details;
      }
      return null;
    }
    return extractMcpResponseObjectErrorDetails(payload);
  } catch {
    return payloadText.includes('"isError":true') || payloadText.includes('"error":{') ? {} : null;
  }
}

function extractMcpResponseObjectErrorDetails(payload: unknown): { errorCode?: string; errorReason?: string } | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.error)) {
    return {
      errorCode: payload.error.code !== undefined ? String(payload.error.code) : undefined,
      errorReason: typeof payload.error.message === 'string' ? payload.error.message : undefined,
    };
  }
  if (!isRecord(payload.result) || payload.result.isError !== true) return null;
  const content = Array.isArray(payload.result.content) ? payload.result.content : [];
  const textItem = content.find((item): item is { text: string } => isRecord(item) && typeof item.text === 'string');
  if (!textItem) return {};
  try {
    const parsedText = JSON.parse(textItem.text) as unknown;
    if (!isRecord(parsedText)) return {};
    return {
      errorCode: typeof parsedText.error === 'string' ? parsedText.error : undefined,
      errorReason: typeof parsedText.message === 'string' ? parsedText.message : undefined,
    };
  } catch {
    return { errorReason: textItem.text };
  }
}

export function startMcpHttpServer(options: StartMcpHttpServerOptions): ReturnType<typeof Bun.serve> {
  const handler = createMcpHttpHandler(options);
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: options.host,
    port: options.port,
    // NOTE: this is the direct TCP peer address. Behind a reverse proxy every
    // request shares the proxy's address (one OAuth rate-limit bucket for all
    // clients); X-Forwarded-For is deliberately not trusted here.
    fetch: (request): Promise<Response> => handler(request, server.requestIP(request)?.address ?? null),
  });
  return server;
}

async function authenticateMcpHttpRequest(
  config: MBrainConfig,
  request: Request,
): Promise<McpHttpAuthResult> {
  const authHeader = request.headers.get('Authorization');
  const token = parseBearerToken(authHeader);
  if (!token) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'missing_auth',
        message: "Authorization header required. Use 'Bearer <token>' format.",
        docs: 'docs/mcp/DEPLOY.md#remote-setup',
      },
    };
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');

  try {
    const row = await findAccessToken(config, tokenHash);
    if (!row) {
      return {
        ok: false,
        status: 401,
        body: {
          error: 'invalid_token',
          message: "Token not recognized. Run 'bun run src/commands/auth.ts create <name>' to create one.",
          docs: 'docs/mcp/DEPLOY.md#troubleshooting',
        },
      };
    }

    if (row.revoked_at) {
      if (row.name.startsWith('oauth:')) {
        return {
          ok: false,
          status: 401,
          body: {
            error: 'invalid_token',
            message: 'This OAuth access token was rotated. Use the OAuth refresh token or reconnect.',
            docs: 'docs/mcp/CHATGPT.md',
          },
        };
      }
      return {
        ok: false,
        status: 403,
        body: {
          error: 'token_revoked',
          message: 'This token was revoked. Create a new token before connecting.',
          docs: 'docs/mcp/DEPLOY.md#troubleshooting',
        },
      };
    }

    if (accessTokenExpired(row.scopes)) {
      return {
        ok: false,
        status: 401,
        body: {
          error: 'token_expired',
          message: 'This OAuth access token expired. Use the OAuth refresh token or reconnect.',
          docs: 'docs/mcp/CHATGPT.md',
        },
      };
    }

    const tokenName = row.name.length > 0
      ? row.name
      : 'unknown';
    await markAccessTokenUsed(config, tokenHash);
    return { ok: true, tokenId: row.id, tokenName, scopes: row.scopes };
  } catch {
    return {
      ok: false,
      status: 503,
      body: {
        error: 'service_unavailable',
        message: 'Could not validate the MCP access token against the configured brain.',
        docs: 'docs/mcp/DEPLOY.md#troubleshooting',
      },
    };
  }
}

async function findAccessToken(
  config: MBrainConfig,
  tokenHash: string,
): Promise<{ id?: string; name: string; revoked_at: unknown; scopes: string[] } | null> {
  switch (config.engine) {
    case 'postgres': {
      if (!config.database_url) throw new Error('Missing database_url');
      const sql = postgres(config.database_url, { max: 1 });
      try {
        const rows = await sql`
          SELECT id, name, revoked_at, scopes FROM access_tokens
          WHERE token_hash = ${tokenHash}
        `;
        const row = rows[0];
        return row ? {
          id: row.id ? String(row.id) : undefined,
          name: String(row.name ?? ''),
          revoked_at: row.revoked_at,
          scopes: parseAccessTokenScopes(row.scopes),
        } : null;
      } finally {
        await sql.end();
      }
    }
    case 'sqlite': {
      if (!config.database_path) throw new Error('Missing database_path');
      const db = new Database(config.database_path);
      try {
        const row = db
          .query('SELECT id, name, revoked_at, scopes FROM access_tokens WHERE token_hash = ?')
          .get(tokenHash) as { id?: unknown; name?: unknown; revoked_at?: unknown; scopes?: unknown } | null;
        return row ? {
          id: row.id ? String(row.id) : undefined,
          name: String(row.name ?? ''),
          revoked_at: row.revoked_at,
          scopes: parseAccessTokenScopes(row.scopes),
        } : null;
      } finally {
        db.close();
      }
    }
    case 'pglite':
      throw new Error('HTTP bearer auth is not supported for pglite');
  }
}

async function issueMcpHttpAccessToken(
  config: MBrainConfig,
  input: McpOAuthAccessTokenInput,
): Promise<string> {
  const token = `mbrain_${randomBytes(32).toString('hex')}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const bindingScope = oauthBindingScope(input.tokenBinding);
  const clientIdScope = `oauth_client_id:${input.clientId}`;
  const revokeScope = input.revokeTokenBinding ? oauthBindingScope(input.revokeTokenBinding) : null;
  const scopes = [...new Set([...input.scope, `oauth_exp:${Math.floor(input.expiresAt.getTime() / 1000)}`, bindingScope, clientIdScope])];
  const name = `oauth:${input.clientName}`;
  const revokeName = `oauth:${input.revokeClientName ?? input.clientName}`;

  switch (config.engine) {
    case 'postgres': {
      if (!config.database_url) throw new Error('Missing database_url');
      const sql = postgres(config.database_url, { max: 1 });
      try {
        await sql.begin(async tx => {
          if (revokeScope) {
            const revoked = await tx`
              UPDATE access_tokens
              SET revoked_at = now()
              WHERE name = ${revokeName}
                AND revoked_at IS NULL
                AND ${revokeScope} = ANY(scopes)
                AND ${clientIdScope} = ANY(scopes)
              RETURNING id
            `;
            if (revoked.length !== 1) {
              throw new OAuthRefreshTokenReplayError();
            }
          }
          await tx`
            INSERT INTO access_tokens (name, token_hash, scopes)
            VALUES (${name}, ${tokenHash}, ${scopes})
          `;
        });
      } finally {
        await sql.end();
      }
      return token;
    }
    case 'sqlite': {
      if (!config.database_path) throw new Error('Missing database_path');
      const db = new Database(config.database_path);
      try {
        const issueToken = db.transaction(() => {
          if (revokeScope) {
            const revoked = db.query(`
              UPDATE access_tokens
              SET revoked_at = ?
              WHERE name = ?
                AND revoked_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM json_each(access_tokens.scopes)
                  WHERE value = ?
                )
                AND EXISTS (
                  SELECT 1 FROM json_each(access_tokens.scopes)
                  WHERE value = ?
                )
            `).run(new Date().toISOString(), revokeName, revokeScope, clientIdScope);
            if (revoked.changes !== 1) {
              throw new OAuthRefreshTokenReplayError();
            }
          }
          db.query(`
            INSERT INTO access_tokens (id, name, token_hash, scopes)
            VALUES (?, ?, ?, ?)
          `).run(randomUUID(), name, tokenHash, JSON.stringify(scopes));
        });
        issueToken();
      } finally {
        db.close();
      }
      return token;
    }
    case 'pglite':
      throw new Error('HTTP OAuth token issuance is not supported for pglite');
  }
}

function oauthBindingScope(binding: string): string {
  return `oauth_binding:${binding}`;
}

async function markAccessTokenUsed(config: MBrainConfig, tokenHash: string): Promise<void> {
  switch (config.engine) {
    case 'postgres': {
      if (!config.database_url) throw new Error('Missing database_url');
      const sql = postgres(config.database_url, { max: 1 });
      try {
        await sql`UPDATE access_tokens SET last_used_at = now() WHERE token_hash = ${tokenHash}`;
      } finally {
        await sql.end();
      }
      return;
    }
    case 'sqlite': {
      if (!config.database_path) throw new Error('Missing database_path');
      const db = new Database(config.database_path);
      try {
        db.query('UPDATE access_tokens SET last_used_at = ? WHERE token_hash = ?')
          .run(new Date().toISOString(), tokenHash);
      } finally {
        db.close();
      }
      return;
    }
    case 'pglite':
      throw new Error('HTTP bearer auth is not supported for pglite');
  }
}

async function handleHealth(enginePromise: Promise<BrainEngine>): Promise<Response> {
  try {
    await enginePromise;
    return jsonResponse({
      status: 'ok',
      transport: 'http',
    }, 200);
  } catch {
    return jsonResponse({
      status: 'error',
      transport: 'http',
    }, 503);
  }
}

type BoundedHttpRequest =
  | { ok: true; request: Request }
  | { ok: false; body: Record<string, unknown> };

async function boundHttpRequestBody(request: Request): Promise<BoundedHttpRequest> {
  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const bodyBytes = Number(contentLength);
    if (Number.isFinite(bodyBytes) && bodyBytes > MAX_MCP_HTTP_BODY_BYTES) {
      return mcpRequestTooLarge();
    }
  }

  if (request.method !== 'POST' || !request.body) {
    return { ok: true, request };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_MCP_HTTP_BODY_BYTES) {
      await reader.cancel();
      return mcpRequestTooLarge();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    ok: true,
    request: new Request(request.url, {
      method: request.method,
      headers: new Headers(request.headers),
      body,
      signal: request.signal,
    }),
  };
}

function mcpRequestTooLarge(): BoundedHttpRequest {
  return {
    ok: false,
    body: {
      error: 'request_too_large',
      message: `MCP HTTP request bodies must be ${MAX_MCP_HTTP_BODY_BYTES} bytes or smaller.`,
    },
  };
}

function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function logRequest(options: McpHttpHandlerOptions, entry: McpHttpRequestLogEntry): Promise<void> {
  try {
    if (options.logRequest) {
      await options.logRequest(entry);
      return;
    }
    await logMcpHttpRequest(options.config, entry);
  } catch {
    process.stderr.write('[warn] failed to log MCP HTTP request\n');
  }
}

async function logMcpHttpRequest(config: MBrainConfig, entry: McpHttpRequestLogEntry): Promise<void> {
  const authPrincipalJson = serializeAuthPrincipal(entry.authPrincipal);
  switch (config.engine) {
    case 'postgres': {
      if (!config.database_url) throw new Error('Missing database_url');
      const sql = postgres(config.database_url, { max: 1 });
      try {
        await insertMcpHttpRequestLogPostgres(sql, entry, authPrincipalJson);
      } finally {
        await sql.end();
      }
      return;
    }
    case 'sqlite': {
      if (!config.database_path) throw new Error('Missing database_path');
      const db = new Database(config.database_path);
      try {
        insertMcpHttpRequestLogSqlite(db, entry, authPrincipalJson);
      } finally {
        db.close();
      }
      return;
    }
    case 'pglite':
      throw new Error('HTTP request logging is not supported for pglite');
  }
}

async function insertMcpHttpRequestLogPostgres(
  sql: ReturnType<typeof postgres>,
  entry: McpHttpRequestLogEntry,
  authPrincipalJson: string | null,
): Promise<void> {
  try {
    await insertMcpHttpRequestLogPostgresRow(sql, entry, authPrincipalJson);
  } catch (error) {
    if (!isMissingAuthPrincipalLogColumn(error)) throw error;
    await sql`ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS auth_principal_json TEXT`;
    await insertMcpHttpRequestLogPostgresRow(sql, entry, authPrincipalJson);
  }
}

async function insertMcpHttpRequestLogPostgresRow(
  sql: ReturnType<typeof postgres>,
  entry: McpHttpRequestLogEntry,
  authPrincipalJson: string | null,
): Promise<void> {
  await sql`
    INSERT INTO mcp_request_log (token_name, operation, latency_ms, status, error_code, error_reason, surface_profile, auth_principal_json)
    VALUES (${entry.tokenName}, ${entry.operation}, ${entry.latencyMs}, ${entry.status}, ${entry.errorCode ?? null}, ${entry.errorReason ?? null}, ${entry.surfaceProfile ?? null}, ${authPrincipalJson})
  `;
}

function insertMcpHttpRequestLogSqlite(
  db: Database,
  entry: McpHttpRequestLogEntry,
  authPrincipalJson: string | null,
): void {
  try {
    insertMcpHttpRequestLogSqliteRow(db, entry, authPrincipalJson);
  } catch (error) {
    if (!isMissingAuthPrincipalLogColumn(error)) throw error;
    db.exec(`ALTER TABLE mcp_request_log ADD COLUMN auth_principal_json TEXT;`);
    insertMcpHttpRequestLogSqliteRow(db, entry, authPrincipalJson);
  }
}

function insertMcpHttpRequestLogSqliteRow(
  db: Database,
  entry: McpHttpRequestLogEntry,
  authPrincipalJson: string | null,
): void {
  db.query(`
    INSERT INTO mcp_request_log (token_name, operation, latency_ms, status, error_code, error_reason, surface_profile, auth_principal_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(entry.tokenName, entry.operation, entry.latencyMs, entry.status, entry.errorCode ?? null, entry.errorReason ?? null, entry.surfaceProfile ?? null, authPrincipalJson);
}

function isMissingAuthPrincipalLogColumn(error: unknown): boolean {
  const maybe = error as { code?: unknown; message?: unknown };
  return maybe.code === '42703'
    || String(maybe.message ?? error).includes('auth_principal_json');
}

function jsonResponse(body: Record<string, unknown>, status: number, extraHeaders: Record<string, string | undefined> = {}): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value) headers[key] = value;
  }
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

function applyExtraHeaders(response: Response, extra: Record<string, string>): Response {
  const entries = Object.entries(extra);
  if (entries.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of entries) {
    if (key === 'Vary') {
      const existing = headers.get('Vary');
      headers.set('Vary', existing && !existing.split(',').map((v) => v.trim()).includes(value) ? `${existing}, ${value}` : existing ?? value);
      continue;
    }
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function corsHeadersFor(request: Request, allowedOrigins: string[] | undefined): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins || allowedOrigins.length === 0) return {};
  if (!allowedOrigins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  };
}

// OAuth credential endpoints are the brute-force surface; the metadata
// discovery documents stay unthrottled.
const OAUTH_ENDPOINT_RATE_LIMIT = { capacity: 10, windowMs: 60_000, maxKeys: 1_024 };

function isRateLimitedOAuthPath(pathname: string): boolean {
  return pathname === '/oauth/register'
    || pathname === '/oauth/authorize'
    || pathname === '/oauth/token';
}

export function createFixedWindowRateLimiter(limit: { capacity: number; windowMs: number; maxKeys: number }) {
  const windows = new Map<string, { windowStart: number; count: number }>();
  return {
    allow(key: string, now = Date.now()): boolean {
      const existing = windows.get(key);
      if (!existing || now - existing.windowStart >= limit.windowMs) {
        if (!existing && windows.size >= limit.maxKeys) {
          // Bound memory under address churn by evicting the oldest entry.
          // (A full clear() would let an attacker with maxKeys addresses
          // reset everyone's counters at will.)
          const oldest = windows.keys().next().value;
          if (oldest !== undefined) windows.delete(oldest);
        }
        windows.set(key, { windowStart: now, count: 1 });
        return true;
      }
      existing.count += 1;
      return existing.count <= limit.capacity;
    },
  };
}

function parseAccessTokenScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return value.split(',').map(entry => entry.trim()).filter(Boolean);
  }
}

function createMcpOAuthStore(config: MBrainConfig): McpOAuthStore {
  if (config.engine !== 'postgres' || !config.database_url) {
    throw new Error(
      'HTTP OAuth setup state requires the Postgres engine. Use bearer-token HTTP MCP for SQLite/PGLite or run with Postgres.',
    );
  }
  const databaseUrl = config.database_url;
  return {
    async saveClient(record) {
      const sql = postgres(databaseUrl, { max: 1 });
      try {
        let pendingCapacityReached = false;
        await sql.begin(async tx => {
          await tx`SELECT pg_advisory_xact_lock(hashtext('mbrain.oauth.dcr'))`;
          await pruneMcpOAuthSetupState(tx as unknown as ReturnType<typeof postgres>);
          const pending = await tx`
            SELECT count(*)::int AS count
            FROM oauth_dcr_clients
            WHERE last_authorized_at IS NULL
          `;
          if (Number(pending[0]?.count ?? 0) >= MAX_PENDING_OAUTH_DCR_CLIENTS) {
            pendingCapacityReached = true;
            return;
          }
          await tx`
            INSERT INTO oauth_dcr_clients (
              client_id, client_name, redirect_uris, token_endpoint_auth_method, issued_at
            )
            VALUES (
              ${record.client_id},
              ${record.client_name},
              ${record.redirect_uris},
              'none',
              to_timestamp(${record.issued_at})
            )
            ON CONFLICT (client_id) DO UPDATE SET
              client_name = EXCLUDED.client_name,
              redirect_uris = EXCLUDED.redirect_uris,
              token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method
          `;
        });
        if (pendingCapacityReached) {
          throw new OAuthStoreCapacityError();
        }
      } finally {
        await sql.end();
      }
    },
    async getClient(clientId) {
      const sql = postgres(databaseUrl, { max: 1 });
      try {
        const rows = await sql`
          SELECT client_id, client_name, redirect_uris, issued_at
          FROM oauth_dcr_clients
          WHERE client_id = ${clientId}
        `;
        return rowToOAuthClient(rows[0]);
      } finally {
        await sql.end();
      }
    },
    async saveAuthorizationCode(code, record) {
      const sql = postgres(databaseUrl, { max: 1 });
      try {
        await sql`
          INSERT INTO oauth_authorization_codes (
            code_hash, client_id, redirect_uri, code_challenge, scope, expires_at
          )
          VALUES (
            ${oauthCodeHash(code)},
            ${record.client_id},
            ${record.redirect_uri},
            ${record.code_challenge},
            ${record.scope},
            to_timestamp(${record.expires_at})
          )
        `;
      } finally {
        await sql.end();
      }
    },
    async consumeAuthorizationCode(code, expected) {
      const sql = postgres(databaseUrl, { max: 1 });
      try {
        const rows = await sql`
          WITH consumed AS (
            UPDATE oauth_authorization_codes
            SET used_at = now()
            WHERE code_hash = ${oauthCodeHash(code)}
              AND client_id = ${expected.client_id}
              AND redirect_uri = ${expected.redirect_uri}
              AND code_challenge = ${expected.code_challenge}
              AND used_at IS NULL
              AND expires_at > now()
            RETURNING client_id, redirect_uri, code_challenge, scope, expires_at, used_at
          ), authorized AS (
            UPDATE oauth_dcr_clients client
            SET last_authorized_at = now()
            FROM consumed
            WHERE client.client_id = consumed.client_id
            RETURNING client.client_id
          )
          SELECT consumed.client_id, consumed.redirect_uri, consumed.code_challenge,
                 consumed.scope, consumed.expires_at, consumed.used_at
          FROM consumed
          LEFT JOIN authorized ON authorized.client_id = consumed.client_id
        `;
        return rowToOAuthAuthorizationCode(rows[0]);
      } finally {
        await sql.end();
      }
    },
  };
}

async function pruneMcpOAuthSetupState(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`
    DELETE FROM oauth_authorization_codes
    WHERE expires_at < now() - (${OAUTH_AUTHORIZATION_CODE_RETENTION_SECONDS} * interval '1 second')
       OR (used_at IS NOT NULL AND used_at < now() - (${OAUTH_AUTHORIZATION_CODE_RETENTION_SECONDS} * interval '1 second'))
  `;
  await sql`
    DELETE FROM oauth_dcr_clients
    WHERE last_authorized_at IS NULL
      AND issued_at < now() - (${PENDING_OAUTH_DCR_CLIENT_TTL_SECONDS} * interval '1 second')
  `;
}

function oauthCodeHash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function rowToOAuthClient(row: unknown): OAuthClientRecord | null {
  if (!isRecord(row)) return null;
  const clientId = typeof row.client_id === 'string' ? row.client_id : '';
  const clientName = typeof row.client_name === 'string' ? row.client_name : '';
  const redirectUris = Array.isArray(row.redirect_uris)
    ? row.redirect_uris.filter((value): value is string => typeof value === 'string')
    : [];
  const issuedAt = timestampSeconds(row.issued_at);
  if (!clientId || !clientName || issuedAt === null) return null;
  return {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    issued_at: issuedAt,
  };
}

function rowToOAuthAuthorizationCode(row: unknown): OAuthAuthorizationCodeRecord | null {
  if (!isRecord(row)) return null;
  const clientId = typeof row.client_id === 'string' ? row.client_id : '';
  const redirectUri = typeof row.redirect_uri === 'string' ? row.redirect_uri : '';
  const codeChallenge = typeof row.code_challenge === 'string' ? row.code_challenge : '';
  const scope = Array.isArray(row.scope)
    ? row.scope.filter((value): value is string => typeof value === 'string')
    : [];
  const expiresAt = timestampSeconds(row.expires_at);
  if (!clientId || !redirectUri || !codeChallenge || expiresAt === null) return null;
  return {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    scope,
    expires_at: expiresAt,
    used: row.used_at !== null && row.used_at !== undefined,
  };
}

function timestampSeconds(value: unknown): number | null {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === 'string') {
    const time = Date.parse(value);
    return Number.isFinite(time) ? Math.floor(time / 1000) : null;
  }
  return null;
}

function accessTokenExpired(scopes: string[]): boolean {
  const expiresAt = scopes
    .map(scope => scope.startsWith('oauth_exp:') ? Number(scope.slice('oauth_exp:'.length)) : null)
    .find((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return expiresAt !== undefined && expiresAt <= Math.floor(Date.now() / 1000);
}
