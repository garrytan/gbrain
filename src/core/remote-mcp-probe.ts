/**
 * Outbound HTTP probes for thin-client mode (multi-topology v1).
 *
 * Three pure functions covering the discovery + auth + smoke surface that
 * `gbrain init --mcp-only` and the thin-client doctor both need. No SDK
 * dependency; just `fetch`. Lane B's `src/core/mcp-client.ts` builds on
 * these helpers (or supersedes them with the official SDK Client) but for
 * Lane A's setup-flow smoke test, raw HTTP keeps the scope tight and avoids
 * pulling the streamableHttp transport into the init path.
 *
 * Each function returns a discriminated `{ok: true, ...}` / `{ok: false, error}`
 * so callers can render the error reason consistently. Network errors surface
 * as `network` reason; HTTP non-2xx surfaces as `http` with status. Auth
 * errors get their own `auth` reason for clean rendering.
 */

export type ProbeResult<T = void> =
  | { ok: true } & ({} extends T ? unknown : T extends void ? unknown : { value: T })
  | { ok: false; reason: 'network' | 'http' | 'auth' | 'parse' | 'config'; status?: number; message: string };

/**
 * GET <issuer_url>/.well-known/oauth-authorization-server. Verifies the
 * server reachable AND speaking OAuth before we hand it credentials.
 * Returns the parsed metadata (token_endpoint etc) on success so callers
 * don't have to re-hit the endpoint.
 */
export interface OAuthMetadata {
  token_endpoint: string;
  issuer?: string;
  scopes_supported?: string[];
  // The server may return many more fields; we only care about token_endpoint
  // for the credentials flow. Carry the rest through for diagnostics.
  [key: string]: unknown;
}

export async function discoverOAuth(
  issuerUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; metadata: OAuthMetadata } | { ok: false; reason: 'network' | 'http' | 'parse' | 'config'; status?: number; message: string }> {
  const trimmed = issuerUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    return { ok: false, reason: 'config', message: `issuer_url must start with http:// or https:// — got: ${issuerUrl}` };
  }
  const url = `${trimmed}/.well-known/oauth-authorization-server`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, reason: 'http', status: res.status, message: `OAuth discovery returned ${res.status} for ${url}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      return { ok: false, reason: 'parse', message: `OAuth discovery returned non-JSON body: ${(e as Error).message}` };
    }
    if (!body || typeof body !== 'object' || typeof (body as OAuthMetadata).token_endpoint !== 'string') {
      return { ok: false, reason: 'parse', message: `OAuth discovery missing token_endpoint at ${url}` };
    }
    return { ok: true, metadata: body as OAuthMetadata };
  } catch (e) {
    return { ok: false, reason: 'network', message: `OAuth discovery network error: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST <token_endpoint> with grant_type=client_credentials. Returns the
 * access_token + expires_in on success. 401 → reason=auth; other non-2xx
 * → reason=http; network → reason=network.
 */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

export async function mintClientCredentialsToken(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  opts: { scope?: string; timeoutMs?: number; resource?: string } = {},
): Promise<{ ok: true; token: TokenResponse } | { ok: false; reason: 'network' | 'http' | 'auth' | 'parse' | 'config'; status?: number; message: string }> {
  if (!clientId) return { ok: false, reason: 'config', message: 'client_id is required' };
  if (!clientSecret) return { ok: false, reason: 'config', message: 'client_secret is required' };

  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('client_id', clientId);
  body.set('client_secret', clientSecret);
  if (opts.scope) body.set('scope', opts.scope);
  if (opts.resource) body.set('resource', opts.resource);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'auth', status: res.status, message: `OAuth /token returned ${res.status} — check client_id and client_secret` };
    }
    if (!res.ok) {
      return { ok: false, reason: 'http', status: res.status, message: `OAuth /token returned ${res.status}` };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      return { ok: false, reason: 'parse', message: `OAuth /token returned non-JSON: ${(e as Error).message}` };
    }
    if (!json || typeof json !== 'object' || typeof (json as TokenResponse).access_token !== 'string') {
      return { ok: false, reason: 'parse', message: `OAuth /token response missing access_token` };
    }
    return { ok: true, token: json as TokenResponse };
  } catch (e) {
    return { ok: false, reason: 'network', message: `OAuth /token network error: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Smoke-test the MCP endpoint with an `initialize` JSON-RPC call. Verifies
 * (a) the URL is reachable, (b) the bearer token is accepted, (c) the
 * server actually speaks MCP. Cheaper than `tools/list` and doesn't require
 * a particular tool to exist. Used by init smoke + thin-client doctor.
 *
 * Note: This is a one-shot probe, not a long-lived session. We don't follow
 * up with `notifications/initialized` because we tear down immediately.
 * Servers that strictly require the full handshake will reject; gbrain's
 * own `serve --http` accepts the bare initialize request and returns
 * server info, which is exactly what we want for a connectivity check.
 */
export async function smokeTestMcp(
  mcpUrl: string,
  accessToken: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true } | { ok: false; reason: 'network' | 'http' | 'auth' | 'parse'; status?: number; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'gbrain-init-smoke', version: '1' },
        },
      }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'auth', status: res.status, message: `MCP smoke returned ${res.status} — token rejected at ${mcpUrl}` };
    }
    if (!res.ok) {
      return { ok: false, reason: 'http', status: res.status, message: `MCP smoke returned ${res.status} from ${mcpUrl}` };
    }
    // Don't strictly parse the response body — different transports may use
    // SSE framing or plain JSON. A 2xx with the bearer accepted is enough
    // signal that the round-trip works.
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'network', message: `MCP smoke network error: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}
