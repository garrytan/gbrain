/**
 * Outbound HTTP MCP client for thin-client mode (multi-topology v1, Tier B).
 *
 * Wraps the official @modelcontextprotocol/sdk Client + StreamableHTTPClientTransport
 * with OAuth `client_credentials` minting + token caching + 401 retry. Used by:
 *   - `gbrain remote ping`   — submits autopilot-cycle, polls get_job
 *   - `gbrain remote doctor` — calls run_doctor MCP op
 *
 * Token caching strategy: in-process Map keyed by mcp_url, value carries the
 * access_token + expires_at. CLI invocations are short-lived; the cache
 * amortizes when a single `gbrain remote ping` makes multiple calls (submit_job
 * + N × get_job). Persisting to disk would create a credential-on-disk
 * surface for marginal benefit — re-mint is a single sub-100ms /token call.
 *
 * 401 handling: on a tool-call rejection, drop the cached token, mint fresh
 * once, retry the call. If the second attempt also 401s, surface a structured
 * error with the mcp_url + suggested remedy. Auth-failure-after-refresh is the
 * canonical "client credentials revoked or scope insufficient" signal.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { GBrainConfig } from './config.ts';
import { discoverOAuth, mintClientCredentialsToken } from './remote-mcp-probe.ts';

interface CachedToken {
  access_token: string;
  /** Wall-clock ms when this token expires. Conservative: 30s safety margin
   *  against clock skew so we mint fresh BEFORE the server says expired. */
  expires_at_ms: number;
}

const tokenCache = new Map<string, CachedToken>();

/**
 * Test-only escape hatch. Tests that mock the OAuth fixture across multiple
 * runs need to invalidate the cache between runs. Production callers should
 * never need this — the 401 path handles staleness automatically.
 */
export function _clearMcpClientTokenCache(): void {
  tokenCache.clear();
}

export class RemoteMcpError extends Error {
  constructor(
    public readonly reason: 'config' | 'discovery' | 'auth' | 'auth_after_refresh' | 'network' | 'tool_error' | 'parse',
    message: string,
    public readonly detail?: { status?: number; mcp_url?: string },
  ) {
    super(message);
    this.name = 'RemoteMcpError';
  }
}

function requireRemoteMcp(config: GBrainConfig | null): NonNullable<GBrainConfig['remote_mcp']> {
  if (!config?.remote_mcp) {
    throw new RemoteMcpError(
      'config',
      'No remote_mcp config. Run `gbrain init --mcp-only` first.',
    );
  }
  return config.remote_mcp;
}

function resolveSecret(remote: NonNullable<GBrainConfig['remote_mcp']>): string {
  const secret = process.env.GBRAIN_REMOTE_CLIENT_SECRET ?? remote.oauth_client_secret;
  if (!secret) {
    throw new RemoteMcpError(
      'config',
      'No client_secret available. Set GBRAIN_REMOTE_CLIENT_SECRET or rerun `gbrain init --mcp-only`.',
    );
  }
  return secret;
}

/**
 * Mint or reuse a cached access_token for the given config. Throws
 * RemoteMcpError on discovery failure or auth rejection.
 */
async function getAccessToken(config: GBrainConfig, force = false): Promise<string> {
  const remote = requireRemoteMcp(config);
  const cached = tokenCache.get(remote.mcp_url);
  if (!force && cached && cached.expires_at_ms > Date.now()) {
    return cached.access_token;
  }

  const secret = resolveSecret(remote);

  const disco = await discoverOAuth(remote.issuer_url);
  if (!disco.ok) {
    throw new RemoteMcpError(
      disco.reason === 'http' || disco.reason === 'parse' ? 'discovery' : 'network',
      `OAuth discovery failed: ${disco.message}`,
      { ...(disco.status ? { status: disco.status } : {}), mcp_url: remote.mcp_url },
    );
  }

  const tokenRes = await mintClientCredentialsToken(disco.metadata.token_endpoint, remote.oauth_client_id, secret, {
    resource: remote.mcp_url,
  });
  if (!tokenRes.ok) {
    throw new RemoteMcpError(
      tokenRes.reason === 'auth' ? 'auth' : tokenRes.reason === 'network' ? 'network' : 'discovery',
      `OAuth /token failed: ${tokenRes.message}`,
      { ...(tokenRes.status ? { status: tokenRes.status } : {}), mcp_url: remote.mcp_url },
    );
  }

  const ttlSec = tokenRes.token.expires_in ?? 3600;
  const expires_at_ms = Date.now() + Math.max(0, ttlSec * 1000 - 30_000);
  const token: CachedToken = { access_token: tokenRes.token.access_token, expires_at_ms };
  tokenCache.set(remote.mcp_url, token);
  return token.access_token;
}

/**
 * Build a connected Client with the given bearer. Caller is responsible for
 * `await client.close()` after use. Each tool call gets its own short-lived
 * Client because StreamableHTTPClientTransport doesn't expose a clean way to
 * swap headers on an existing connection — re-mint + reconnect on 401 is
 * cheaper than reusing.
 */
async function buildClient(mcpUrl: string, accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    },
  });
  const client = new Client(
    { name: 'gbrain-remote-cli', version: '1' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

/**
 * Call an MCP tool on the remote server. Handles auth refresh on 401 once.
 * Returns the parsed `result` payload from the tool response.
 *
 * Throws RemoteMcpError on:
 *   - missing remote_mcp config
 *   - OAuth discovery / token failures
 *   - 401 after refresh attempt (auth_after_refresh)
 *   - tool-call errors (tool_error)
 *   - network errors
 */
export async function callRemoteTool(
  config: GBrainConfig,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const remote = requireRemoteMcp(config);

  // Step 1: mint (or reuse cached) token. If THIS fails — bad credentials,
  // unreachable issuer, etc. — surface immediately. Retry-on-401 is for
  // the mid-session token-rotation case, NOT for initial-credentials-wrong.
  const initialToken = await getAccessToken(config, false);

  // Step 2: try the tool call. On a 401-shaped failure here, drop the cache
  // and retry ONCE with a freshly-minted token (handles host-side rotation
  // mid-session). If the retry also fails auth, surface auth_after_refresh.
  const tryCall = async (token: string): Promise<unknown> => {
    const client = await buildClient(remote.mcp_url, token);
    try {
      const res = await client.callTool({ name: toolName, arguments: args });
      if (res.isError) {
        const message = Array.isArray(res.content)
          ? res.content.map((c: unknown) => (c as { text?: string }).text ?? '').join('\n')
          : 'unknown tool error';
        throw new RemoteMcpError('tool_error', `Remote tool ${toolName} failed: ${message}`, { mcp_url: remote.mcp_url });
      }
      return res;
    } finally {
      try { await client.close(); } catch { /* best-effort */ }
    }
  };

  try {
    return await tryCall(initialToken);
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    const looksLike401 = /401|unauthor|invalid.token/i.test(e.message);
    if (!looksLike401) throw e;
    // Drop cached token and retry once with a fresh mint.
    tokenCache.delete(remote.mcp_url);
    let freshToken: string;
    try {
      freshToken = await getAccessToken(config, true);
    } catch (mintErr) {
      // If the fresh mint itself fails auth, surface auth_after_refresh —
      // host-side credentials likely revoked.
      if (mintErr instanceof RemoteMcpError && mintErr.reason === 'auth') {
        throw new RemoteMcpError(
          'auth_after_refresh',
          `Auth failed after token refresh. Verify oauth_client_id and secret are still valid; the host operator may need to re-run \`gbrain auth register-client\`.`,
          { mcp_url: remote.mcp_url },
        );
      }
      throw mintErr;
    }
    try {
      return await tryCall(freshToken);
    } catch (e2) {
      if (e2 instanceof Error && /401|unauthor|invalid.token/i.test(e2.message)) {
        throw new RemoteMcpError(
          'auth_after_refresh',
          `Auth failed after token refresh. Verify oauth_client_id and secret are still valid; the host operator may need to re-run \`gbrain auth register-client\`.`,
          { mcp_url: remote.mcp_url },
        );
      }
      throw e2;
    }
  }
}

/**
 * Extract the structured result from a successful tool-call response. The MCP
 * spec says tool results are returned as `content: Array<{type, text|...}>`.
 * gbrain ops set the JSON-encoded result as `text` of the first content item.
 * This helper parses + types it for the caller.
 */
export function unpackToolResult<T = unknown>(res: unknown): T {
  const content = (res as { content?: unknown[] } | undefined)?.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new RemoteMcpError('parse', 'Remote tool returned no content');
  }
  const first = content[0] as { type?: string; text?: string };
  if (first.type !== 'text' || typeof first.text !== 'string') {
    throw new RemoteMcpError('parse', 'Remote tool returned unexpected content shape');
  }
  try {
    return JSON.parse(first.text) as T;
  } catch (e) {
    throw new RemoteMcpError('parse', `Remote tool result was not valid JSON: ${(e as Error).message}`);
  }
}
