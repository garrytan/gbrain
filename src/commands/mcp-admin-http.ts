import { assertSecureEndpoint, readPrivateText } from '../core/harness/credentials.ts';
import { normalizeMcpUrl } from '../core/mcp-registration.ts';

export class McpAdminError extends Error {
  constructor(readonly code: string, message: string, readonly outcome?: 'unknown', readonly nextAction?: string, readonly httpStatus?: number, readonly retryAfter?: string) {
    super(message);
    this.name = 'McpAdminError';
  }
}

/** Owner credentials are independent of MCP OAuth scopes. No persistent session is created. */
export interface McpAdminHttpOptions {
  url: string;
  adminTokenFile?: string;
  bootstrapToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const secretKey = /^(?:client[_-]?secret(?:[_-]?hash)?|access[_-]?token|refresh[_-]?token|token|authorization|cookie|csrf|code[_-]?verifier)$/i;
export function redactAdminValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]');
    return result.replace(/gbrain_(?:cs|at|rt|code)_[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/(\/admin\/auth\/)[A-Za-z0-9_-]+/g, '$1[redacted]');
  }
  if (Array.isArray(value)) return value.map(item => redactAdminValue(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, secretKey.test(key) ? '[redacted]' : redactAdminValue(item, secrets)]));
  return value;
}

export function adminServerBase(input: string): string {
  const normalized = normalizeMcpUrl(input);
  if (!normalized.ok) throw new McpAdminError('invalid_admin_url', 'Pass the running server URL or its /mcp endpoint with --url.');
  assertSecureEndpoint(normalized.url);
  return normalized.url.replace(/\/mcp\/?$/, '');
}

export function hasAdminCredential(args: string[], envToken = process.env.GBRAIN_ADMIN_BOOTSTRAP_TOKEN): boolean {
  return args.includes('--admin-token-file') || envToken !== undefined;
}

export function createMcpAdminHttp(options: McpAdminHttpOptions) {
  const base = adminServerBase(options.url);
  // An explicit unreadable/invalid file never falls back to a different credential.
  let token: string | undefined;
  if (options.adminTokenFile !== undefined) {
    try {
      token = readPrivateText(options.adminTokenFile).trim();
      if (!token) throw new Error('empty credential');
    } catch {
      throw new McpAdminError('admin_credential_file_invalid', 'The explicit --admin-token-file must name a readable, nonempty private regular file (0600), without symlinks.', undefined,
        'Ask the server administrator to place the current owner bootstrap credential in a private file and pass that file with --admin-token-file.');
    }
  } else token = (options.bootstrapToken ?? process.env.GBRAIN_ADMIN_BOOTSTRAP_TOKEN)?.trim();
  if (!token) throw new McpAdminError('admin_credentials_required', 'Use --admin-token-file <private-file> or GBRAIN_ADMIN_BOOTSTRAP_TOKEN from the server owner. An MCP OAuth token does not administer clients.', undefined,
    'Ask the server administrator for the current owner bootstrap credential, then supply it through a private --admin-token-file or GBRAIN_ADMIN_BOOTSTRAP_TOKEN.');
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new McpAdminError('invalid_timeout', '--timeout-ms must be between 100 and 300000.');
  const fetchImpl = options.fetchImpl ?? fetch;
  let cookie: string | undefined;
  const sanitize = (message: string) => String(redactAdminValue(message, [token, cookie ?? '']))
    .replace(/([?&](?:code|client_secret|access_token|refresh_token|token)=)[^&#\s"']+/gi, '$1[redacted]');

  async function send(path: string, init: RequestInit, mutation: boolean, nextAction?: string): Promise<Response> {
    if (!path.startsWith('/admin/')) throw new McpAdminError('invalid_admin_path', 'Invalid administration endpoint.');
    try {
      return await fetchImpl(`${base}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      if (mutation) throw new McpAdminError('admin_outcome_unknown', 'The server response was lost or timed out; the action may have completed. Inspect the client before retrying.', 'unknown', nextAction);
      throw new McpAdminError('admin_unreachable', 'The administration request failed or timed out. Check --url and that the existing server is running.');
    }
  }

  async function body(response: Response, mutation: boolean, nextAction?: string, authenticating = false): Promise<Record<string, unknown>> {
    if (response.status === 429) {
      const header = response.headers.get('retry-after');
      const retryAfter = header && (/^\d+$/.test(header) || Number.isFinite(Date.parse(header))) ? header : undefined;
      throw new McpAdminError('admin_rate_limited', `Administration is rate limited. ${retryAfter ? `Wait ${/^\d+$/.test(retryAfter) ? retryAfter + ' seconds' : 'until ' + retryAfter}` : 'Wait for the server rate-limit window to reset'} before trying again.`, undefined, nextAction, 429, retryAfter);
    }
    if (authenticating && (response.status === 401 || response.status === 403)) {
      throw new McpAdminError('admin_authentication_failed', 'The running server rejected the owner credential. Obtain its current bootstrap credential from the server administrator and use --admin-token-file; an MCP OAuth token cannot sign in as owner.', undefined, undefined, response.status);
    }
    const upgrade = () => new McpAdminError('server_upgrade_required', 'This running server does not provide the requested administration endpoint. Ask its administrator to upgrade and restart that existing server, then retry.', undefined, undefined, response.status);
    let result: Record<string, unknown>;
    try {
      const parsed: unknown = await response.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      result = parsed as Record<string, unknown>;
    } catch {
      if (response.status === 404 || response.status === 405) throw upgrade();
      if (mutation && (response.ok || response.status >= 500)) throw new McpAdminError('admin_outcome_unknown', 'The server returned an incomplete response; the action may have completed. Inspect the client before retrying.', 'unknown', nextAction, response.status);
      throw new McpAdminError('admin_invalid_response', `Administration returned HTTP ${response.status} without a readable result.`, undefined, nextAction, response.status);
    }
    if (!response.ok) {
      const classification = result.code ?? result.error;
      const code = typeof classification === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(classification) ? classification : 'admin_request_failed';
      if ((response.status === 404 || response.status === 405) && code !== 'client_not_found') throw upgrade();
      const detail = typeof result.message === 'string' ? result.message : typeof result.error === 'string' ? result.error : `HTTP ${response.status}`;
      const unknown = mutation && (response.status >= 500 || result.outcome === 'unknown');
      const remedy = nextAction ?? (typeof result.next_action === 'string' ? sanitize(result.next_action) : undefined);
      throw new McpAdminError(code, sanitize(detail), unknown ? 'unknown' : undefined, remedy, response.status);
    }
    return result;
  }

  async function login(): Promise<void> {
    if (cookie) return;
    const response = await send('/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }, false);
    await body(response, false, undefined, true);
    cookie = response.headers.get('set-cookie')?.match(/(?:^|[, ]\s*)(gbrain_admin=[^;,\s]+)/)?.[1];
    if (!cookie) throw new McpAdminError('admin_authentication_failed', 'The server did not return an owner session cookie.');
  }

  return {
    base,
    sanitize,
    async request(path: string, input: { method?: 'GET' | 'POST'; body?: unknown; mutation?: boolean; nextAction?: string } = {}) {
      await login();
      const response = await send(path, { method: input.method ?? 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie! },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) }, input.mutation === true, input.nextAction);
      return body(response, input.mutation === true, input.nextAction);
    },
    async loginLink(oauthRequest?: string) {
      if (oauthRequest !== undefined && !/^[a-f0-9]{64}$/.test(oauthRequest)) throw new McpAdminError('invalid_oauth_request', '--oauth-request must be the pending request ID shown by the OAuth login page.');
      const response = await send('/admin/api/issue-magic-link', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(oauthRequest === undefined ? {} : { oauth_request: oauthRequest }) }, false);
      const result = await body(response, false, undefined, true);
      if (typeof result.url !== 'string' || typeof result.expires_in !== 'number') throw new McpAdminError('admin_invalid_response', 'The server did not return an owner login link.');
      const link = new URL(result.url);
      assertSecureEndpoint(link.toString());
      if (oauthRequest !== undefined && link.searchParams.get('oauth_request') !== oauthRequest) {
        throw new McpAdminError('server_upgrade_required', 'The running server did not preserve the pending OAuth request in its login link. Ask its administrator to upgrade and restart the existing server, then restart the connection from the client.');
      }
      if (!/^\/admin\/auth\/[a-f0-9]{64}$/.test(link.pathname)
        || [...link.searchParams.keys()].some(key => key !== 'oauth_request')
        || link.searchParams.getAll('oauth_request').length > 1
        || (link.searchParams.has('oauth_request') && link.searchParams.get('oauth_request') !== oauthRequest)) {
        throw new McpAdminError('admin_invalid_response', 'The server returned an invalid owner login link. Check the server public URL.');
      }
      // Host-local administration may return the configured public HTTPS URL.
      // Only the originally selected endpoint ever receives the owner credential.
      // This result intentionally contains the requested single-use link. Never fetch it here.
      return { url: result.url, expires_in: result.expires_in };
    },
  };
}
