import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

export interface McpOAuthOptions {
  enabled?: boolean;
  publicBaseUrl?: string;
  approvalToken?: string;
  signingSecret?: string;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  allowedScopes?: string[];
}

export interface McpOAuthAccessTokenInput {
  clientId: string;
  clientName: string;
  scope: string[];
  expiresAt: Date;
  tokenBinding: string;
  revokeTokenBinding?: string;
  revokeClientName?: string;
}

export interface McpOAuthState {
  options: McpOAuthOptions;
  store: McpOAuthStore;
}

export interface McpOAuthRequestOptions {
  request: Request;
  state: McpOAuthState;
  issueAccessToken: (input: McpOAuthAccessTokenInput) => Promise<string>;
}

export interface OAuthClientRecord {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  issued_at: number;
}

export interface OAuthAuthorizationCodeRecord {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string[];
  expires_at: number;
  used: boolean;
}

export interface OAuthAuthorizationCodeConsumption {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
}

export interface McpOAuthStore {
  saveClient(record: OAuthClientRecord): Promise<void>;
  getClient(clientId: string): Promise<OAuthClientRecord | null>;
  saveAuthorizationCode(code: string, record: OAuthAuthorizationCodeRecord): Promise<void>;
  consumeAuthorizationCode(
    code: string,
    expected: OAuthAuthorizationCodeConsumption,
  ): Promise<OAuthAuthorizationCodeRecord | null>;
}

export class OAuthStoreCapacityError extends Error {
  constructor(message = 'Too many pending OAuth client registrations') {
    super(message);
    this.name = 'OAuthStoreCapacityError';
  }
}

export class OAuthRefreshTokenReplayError extends Error {
  constructor(message = 'OAuth refresh token has already been consumed') {
    super(message);
    this.name = 'OAuthRefreshTokenReplayError';
  }
}

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const SAFE_EQUAL_KEY = 'mbrain-oauth-safe-equal-v1';
const SUPPORTED_OAUTH_SCOPES = ['mcp', 'raw_source', 'canonical_write'] as const;

export function createMcpOAuthState(options: McpOAuthOptions, store: McpOAuthStore = createInMemoryMcpOAuthStore()): McpOAuthState {
  return {
    options,
    store,
  };
}

export function isMcpOAuthPath(pathname: string): boolean {
  return pathname === '/.well-known/oauth-authorization-server'
    || pathname === '/.well-known/oauth-protected-resource'
    || pathname === '/oauth/register'
    || pathname === '/oauth/authorize'
    || pathname === '/oauth/token';
}

export async function handleMcpOAuthRequest({
  request,
  state,
  issueAccessToken,
}: McpOAuthRequestOptions): Promise<Response> {
  const url = new URL(request.url);
  const publicBaseUrl = resolvePublicBaseUrl(request, state.options);

  if (!oauthConfigured(state.options)) {
    return oauthJson({
      error: 'oauth_not_configured',
      message: 'OAuth requires MBRAIN_OAUTH_APPROVAL_TOKEN and MBRAIN_OAUTH_SIGNING_SECRET.',
    }, 503);
  }

  if (url.pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') {
    return oauthJson({
      issuer: publicBaseUrl,
      authorization_endpoint: `${publicBaseUrl}/oauth/authorize`,
      token_endpoint: `${publicBaseUrl}/oauth/token`,
      registration_endpoint: `${publicBaseUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: allowedOAuthScopes(state.options),
    }, 200);
  }

  if (url.pathname === '/.well-known/oauth-protected-resource' && request.method === 'GET') {
    return oauthJson({
      resource: `${publicBaseUrl}/mcp`,
      authorization_servers: [publicBaseUrl],
      bearer_methods_supported: ['header'],
    }, 200);
  }

  if (url.pathname === '/oauth/register' && request.method === 'POST') {
    return handleClientRegistration(request, state);
  }

  if (url.pathname === '/oauth/authorize' && (request.method === 'GET' || request.method === 'POST')) {
    return handleAuthorize(request, state);
  }

  if (url.pathname === '/oauth/token' && request.method === 'POST') {
    return handleToken(request, state, issueAccessToken);
  }

  return oauthJson({ error: 'not_found' }, 404);
}

export function oauthResourceMetadataHeader(request: Request, options?: McpOAuthOptions): string | undefined {
  if (!options?.enabled) return undefined;
  const publicBaseUrl = resolvePublicBaseUrl(request, options);
  return `Bearer resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource"`;
}

async function handleClientRegistration(request: Request, state: McpOAuthState): Promise<Response> {
  const body = await readOAuthBody(request);
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((value): value is string => typeof value === 'string')
    : [];
  if (redirectUris.length === 0 || !redirectUris.every(isAllowedRedirectUri)) {
    return oauthJson({
      error: 'invalid_client_metadata',
      error_description: 'redirect_uris must contain HTTPS URLs or localhost HTTP URLs.',
    }, 400);
  }

  const tokenEndpointAuthMethod = stringValue(body.token_endpoint_auth_method) ?? 'none';
  if (tokenEndpointAuthMethod !== 'none') {
    return oauthJson({
      error: 'invalid_client_metadata',
      error_description: 'Only public clients with token_endpoint_auth_method "none" are supported.',
    }, 400);
  }

  const clientName = stringValue(body.client_name) ?? 'MCP OAuth client';
  const clientId = `mbrain_dcr_${randomBytes(24).toString('base64url')}`;
  const record: OAuthClientRecord = {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    issued_at: Math.floor(Date.now() / 1000),
  };
  try {
    await state.store.saveClient(record);
  } catch (error) {
    if (error instanceof OAuthStoreCapacityError) {
      return oauthJson({
        error: 'temporarily_unavailable',
        error_description: 'Too many pending OAuth client registrations. Complete authorization or try again later.',
      }, 429);
    }
    throw error;
  }

  return oauthJson({
    client_id: clientId,
    client_id_issued_at: record.issued_at,
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }, 201);
}

async function handleAuthorize(request: Request, state: McpOAuthState): Promise<Response> {
  const params = request.method === 'GET'
    ? paramsFromSearch(new URL(request.url).searchParams)
    : await readOAuthBody(request);
  const validation = await validateAuthorizationRequest(params, state);
  if (!validation.ok) return validation.response;

  if (request.method === 'GET') {
    return renderApprovalForm(params, {
      client: validation.client,
      redirectUri: validation.redirectUri,
    });
  }

  const approvalToken = stringValue(params.approval_token);
  if (!approvalTokenMatches(approvalToken, state.options.approvalToken)) {
    return oauthJson({
      error: 'access_denied',
      error_description: 'Approval token did not match.',
    }, 403);
  }

  const code = `mbrain_code_${randomBytes(32).toString('base64url')}`;
  await state.store.saveAuthorizationCode(code, {
    client_id: validation.client.client_id,
    redirect_uri: validation.redirectUri,
    code_challenge: validation.codeChallenge,
    scope: validation.scope,
    expires_at: Math.floor(Date.now() / 1000) + AUTHORIZATION_CODE_TTL_SECONDS,
    used: false,
  });

  const redirect = new URL(validation.redirectUri);
  redirect.searchParams.set('code', code);
  const stateParam = stringValue(params.state);
  if (stateParam) redirect.searchParams.set('state', stateParam);
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect.toString(),
    },
  });
}

async function handleToken(
  request: Request,
  state: McpOAuthState,
  issueAccessToken: (input: McpOAuthAccessTokenInput) => Promise<string>,
): Promise<Response> {
  const params = await readOAuthBody(request);
  const grantType = stringValue(params.grant_type);

  if (grantType === 'authorization_code') {
    return handleAuthorizationCodeToken(params, state, issueAccessToken);
  }

  if (grantType === 'refresh_token') {
    return handleRefreshToken(params, state, issueAccessToken);
  }

  return oauthJson({
    error: 'unsupported_grant_type',
    error_description: 'Supported grant types are authorization_code and refresh_token.',
  }, 400);
}

async function handleAuthorizationCodeToken(
  params: Record<string, unknown>,
  state: McpOAuthState,
  issueAccessToken: (input: McpOAuthAccessTokenInput) => Promise<string>,
): Promise<Response> {
  const code = stringValue(params.code);
  const clientId = stringValue(params.client_id);
  const redirectUri = stringValue(params.redirect_uri);
  const verifier = stringValue(params.code_verifier);
  if (!code || !clientId || !redirectUri || !verifier) {
    return oauthJson({ error: 'invalid_request' }, 400);
  }

  const client = await state.store.getClient(clientId);
  if (!client) {
    return oauthJson({ error: 'invalid_grant' }, 400);
  }
  const record = await state.store.consumeAuthorizationCode(code, {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: pkceChallenge(verifier),
  });
  if (!record) {
    return oauthJson({ error: 'invalid_grant' }, 400);
  }

  return issueOAuthAccessToken(state, client, record.scope, issueAccessToken);
}

async function handleRefreshToken(
  params: Record<string, unknown>,
  state: McpOAuthState,
  issueAccessToken: (input: McpOAuthAccessTokenInput) => Promise<string>,
): Promise<Response> {
  const refreshToken = stringValue(params.refresh_token);
  const clientId = stringValue(params.client_id);
  const payload = refreshToken ? decodeRefreshToken(refreshToken, state.options) : null;
  const now = Math.floor(Date.now() / 1000);
  if (!payload || !payload.token_binding || payload.expires_at <= now || (clientId && payload.client_id !== clientId)) {
    return oauthJson({ error: 'invalid_grant' }, 400);
  }
  const invalidScopes = payload.scope.filter(value => !allowedOAuthScopes(state.options).includes(value));
  if (invalidScopes.length > 0) {
    return oauthJson({
      error: 'invalid_scope',
      error_description: `Unsupported or disabled OAuth scope(s): ${invalidScopes.join(' ')}`,
    }, 400);
  }
  const client = await state.store.getClient(payload.client_id) ?? {
    client_id: payload.client_id,
    client_name: payload.client_name,
    redirect_uris: [],
    issued_at: now,
  };
  return issueOAuthAccessToken(state, client, payload.scope, issueAccessToken, payload.token_binding, payload.client_name);
}

async function issueOAuthAccessToken(
  state: McpOAuthState,
  client: OAuthClientRecord,
  scope: string[],
  issueAccessToken: (input: McpOAuthAccessTokenInput) => Promise<string>,
  revokeTokenBinding?: string,
  revokeClientName?: string,
): Promise<Response> {
  const ttl = state.options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const refreshTtl = state.options.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
  const nowMs = Date.now();
  const tokenBinding = randomBytes(16).toString('hex');
  let accessToken: string;
  try {
    accessToken = await issueAccessToken({
      clientId: client.client_id,
      clientName: client.client_name,
      scope,
      expiresAt: new Date(nowMs + ttl * 1000),
      tokenBinding,
      revokeTokenBinding,
      revokeClientName,
    });
  } catch (error) {
    if (error instanceof OAuthRefreshTokenReplayError) {
      return oauthJson({ error: 'invalid_grant' }, 400);
    }
    return oauthJson({
      error: 'server_error',
      error_description: 'Could not issue an MCP access token for this brain runtime.',
    }, 503);
  }
  const refreshToken = encodeRefreshToken({
    client_id: client.client_id,
    client_name: client.client_name,
    scope,
    expires_at: Math.floor(nowMs / 1000) + refreshTtl,
    token_binding: tokenBinding,
  }, state.options);

  return oauthJson({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ttl,
    refresh_token: refreshToken,
    scope: scope.join(' '),
  }, 200);
}

async function validateAuthorizationRequest(
  params: Record<string, unknown>,
  state: McpOAuthState,
): Promise<{ ok: true; client: OAuthClientRecord; redirectUri: string; codeChallenge: string; scope: string[] } | { ok: false; response: Response }> {
  if (stringValue(params.response_type) !== 'code') {
    return { ok: false, response: oauthJson({ error: 'unsupported_response_type' }, 400) };
  }
  const clientId = stringValue(params.client_id);
  const client = clientId ? await state.store.getClient(clientId) : undefined;
  if (!client) {
    return { ok: false, response: oauthJson({ error: 'invalid_client' }, 400) };
  }
  const redirectUri = stringValue(params.redirect_uri);
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return { ok: false, response: oauthJson({ error: 'invalid_request' }, 400) };
  }
  if (stringValue(params.code_challenge_method) !== 'S256') {
    return { ok: false, response: oauthJson({ error: 'invalid_request', error_description: 'PKCE S256 is required.' }, 400) };
  }
  const codeChallenge = stringValue(params.code_challenge);
  if (!codeChallenge) {
    return { ok: false, response: oauthJson({ error: 'invalid_request', error_description: 'code_challenge is required.' }, 400) };
  }
  const scope = parseScope(stringValue(params.scope));
  const invalidScopes = scope.filter(value => !allowedOAuthScopes(state.options).includes(value));
  if (invalidScopes.length > 0) {
    return {
      ok: false,
      response: oauthJson({
        error: 'invalid_scope',
        error_description: `Unsupported or disabled OAuth scope(s): ${invalidScopes.join(' ')}`,
      }, 400),
    };
  }
  return {
    ok: true,
    client,
    redirectUri,
    codeChallenge,
    scope,
  };
}

function renderApprovalForm(
  params: Record<string, unknown>,
  context: { client: OAuthClientRecord; redirectUri: string },
): Response {
  const scopes = parseScope(stringValue(params.scope));
  const scopeItems = scopes
    .map(scope => `<li><code>${escapeHtml(scope)}</code>${scope === 'canonical_write' || scope === 'raw_source' ? ' <strong>privileged</strong>' : ''}<br><span>${escapeHtml(describeOAuthScope(scope))}</span></li>`)
    .join('\n');
  const hidden = Object.entries(params)
    .filter(([key]) => key !== 'approval_token')
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(String(value ?? ''))}">`)
    .join('\n');
  const redirectOrigin = new URL(context.redirectUri).origin;
  return new Response(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Authorize MBrain MCP</title></head>
  <body>
    <main>
      <h1>Authorize MBrain MCP</h1>
      <section aria-label="Client details">
        <strong>New OAuth client</strong>
        <p>Client: <code>${escapeHtml(context.client.client_name)}</code></p>
        <p>Redirect origin: <code>${escapeHtml(redirectOrigin)}</code></p>
      </section>
      <p>Requested scopes:</p>
      <ul>
        ${scopeItems}
      </ul>
      <form method="post" action="/oauth/authorize">
        ${hidden}
        <label>Approval token <input type="password" name="approval_token" autofocus></label>
        <button type="submit">Authorize</button>
      </form>
    </main>
  </body>
</html>`, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}

function describeOAuthScope(scope: string): string {
  switch (scope) {
    case 'mcp':
      return 'Full compiled-brain read through normal MCP tools; does not grant raw source access or canonical writes.';
    case 'canonical_write':
      return 'Privileged canonical memory mutation scope, including remote put_page when governance requirements are met.';
    case 'raw_source':
      return 'Privileged access to raw source material outside the compiled-brain evidence boundary.';
    default:
      return 'Unknown or unsupported scope.';
  }
}

async function readOAuthBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (contentType.includes('application/json')) {
    const body = await request.json() as unknown;
    return isRecord(body) ? body : {};
  }
  const text = await request.text();
  return paramsFromSearch(new URLSearchParams(text));
}

function paramsFromSearch(searchParams: URLSearchParams): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) params[key] = value;
  return params;
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function approvalTokenMatches(input: string | undefined, configured: string | undefined): boolean {
  if (!input || !configured) return false;
  return safeEqual(input, configured);
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHmac('sha256', SAFE_EQUAL_KEY).update(left).digest();
  const rightDigest = createHmac('sha256', SAFE_EQUAL_KEY).update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function parseScope(raw: string | undefined): string[] {
  const values = (raw ?? 'mcp')
    .split(/\s+/)
    .map(value => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : ['mcp'];
}

function allowedOAuthScopes(options: McpOAuthOptions): string[] {
  const allowed = new Set<string>(['mcp']);
  for (const scope of options.allowedScopes ?? []) {
    if ((SUPPORTED_OAUTH_SCOPES as readonly string[]).includes(scope)) {
      allowed.add(scope);
    }
  }
  return [...allowed];
}

function encodeRefreshToken(
  payload: { client_id: string; client_name: string; scope: string[]; expires_at: number; token_binding: string },
  options: McpOAuthOptions,
): string {
  const secret = signingSecret(options);
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');
  return `mbrain_refresh_${encodedPayload}.${signature}`;
}

function decodeRefreshToken(
  token: string,
  options: McpOAuthOptions,
): { client_id: string; client_name: string; scope: string[]; expires_at: number; token_binding?: string } | null {
  if (!token.startsWith('mbrain_refresh_')) return null;
  const rest = token.slice('mbrain_refresh_'.length);
  const [encodedPayload, signature] = rest.split('.');
  if (!encodedPayload || !signature) return null;
  const expected = createHmac('sha256', signingSecret(options))
    .update(encodedPayload)
    .digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf-8')) as unknown;
    if (!isRecord(payload)) return null;
    const clientId = stringValue(payload.client_id);
    const clientName = stringValue(payload.client_name);
    const tokenBinding = stringValue(payload.token_binding);
    const expiresAt = typeof payload.expires_at === 'number' ? payload.expires_at : null;
    const scope = Array.isArray(payload.scope)
      ? payload.scope.filter((value): value is string => typeof value === 'string')
      : [];
    if (!clientId || !clientName || !expiresAt) return null;
    return {
      client_id: clientId,
      client_name: clientName,
      scope,
      expires_at: expiresAt,
      token_binding: tokenBinding || undefined,
    };
  } catch {
    return null;
  }
}

function oauthConfigured(options: McpOAuthOptions): boolean {
  return Boolean(options.approvalToken && signingSecret(options));
}

function signingSecret(options: McpOAuthOptions): string {
  // No approval-token fallback: the approval token is user-visible and short;
  // refresh-token integrity needs its own dedicated secret.
  return options.signingSecret || '';
}

function resolvePublicBaseUrl(request: Request, options: McpOAuthOptions): string {
  if (options.publicBaseUrl) return options.publicBaseUrl.replace(/\/+$/, '');
  const requestUrl = new URL(request.url);
  const forwardedHost = request.headers.get('X-Forwarded-Host');
  const forwardedProto = request.headers.get('X-Forwarded-Proto');
  const host = forwardedHost || request.headers.get('Host') || requestUrl.host;
  const protocol = forwardedProto || requestUrl.protocol.replace(/:$/, '');
  return `${protocol}://${host}`.replace(/\/+$/, '');
}

function isAllowedRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function oauthJson(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    // CORS is applied centrally by the http-server choke point; emitting a
    // wildcard here would bypass the allowlist.
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}

export function createInMemoryMcpOAuthStore(): McpOAuthStore {
  const clients = new Map<string, OAuthClientRecord>();
  const authorizationCodes = new Map<string, OAuthAuthorizationCodeRecord>();
  const pruneExpiredAuthorizationCodes = () => {
    const now = Math.floor(Date.now() / 1000);
    for (const [code, record] of authorizationCodes) {
      if (record.expires_at <= now || record.used) {
        authorizationCodes.delete(code);
      }
    }
  };
  return {
    async saveClient(record) {
      clients.set(record.client_id, { ...record, redirect_uris: [...record.redirect_uris] });
    },
    async getClient(clientId) {
      const record = clients.get(clientId);
      return record ? { ...record, redirect_uris: [...record.redirect_uris] } : null;
    },
    async saveAuthorizationCode(code, record) {
      pruneExpiredAuthorizationCodes();
      authorizationCodes.set(code, { ...record, scope: [...record.scope] });
    },
    async consumeAuthorizationCode(code, expected) {
      pruneExpiredAuthorizationCodes();
      const record = authorizationCodes.get(code);
      const now = Math.floor(Date.now() / 1000);
      if (!record || record.used || record.expires_at <= now) {
        authorizationCodes.delete(code);
        return null;
      }
      if (
        record.client_id !== expected.client_id
        || record.redirect_uri !== expected.redirect_uri
        || !safeEqual(record.code_challenge, expected.code_challenge)
      ) {
        return null;
      }
      record.used = true;
      authorizationCodes.delete(code);
      return { ...record, scope: [...record.scope] };
    },
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
