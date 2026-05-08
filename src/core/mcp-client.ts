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

/**
 * Stable union of failure reasons. The CLI dispatcher (cli.ts thin-client
 * routing branch, v0.31.1) uses an exhaustive TS switch over this union to
 * produce canned, actionable user messages — adding a new variant fails
 * compilation until every dispatcher knows what to render.
 *
 * v0.31.1 additions:
 *  - `kind` sub-tag on `network` errors distinguishes 'unreachable' /
 *    'timeout' / 'aborted' so callers can render the right hint.
 *  - `code` field on `tool_error` carries the MCP server's `error.code` (when
 *    present) so the dispatcher can map missing-scope etc. to pinpoint hints.
 */
export type RemoteMcpErrorReason =
  | 'config'
  | 'discovery'
  | 'auth'
  | 'auth_after_refresh'
  | 'network'
  | 'tool_error'
  | 'parse';

export interface RemoteMcpErrorDetail {
  status?: number;
  mcp_url?: string;
  /** v0.31.1: sub-tag for network errors (timeout vs aborted vs generic). */
  kind?: 'timeout' | 'aborted' | 'unreachable';
  /** v0.31.1: server-supplied error code on tool_error (e.g. 'missing_scope'). */
  code?: string;
}

export class RemoteMcpError extends Error {
  constructor(
    public readonly reason: RemoteMcpErrorReason,
    message: string,
    public readonly detail?: RemoteMcpErrorDetail,
  ) {
    super(message);
    this.name = 'RemoteMcpError';
  }
}

/**
 * v0.31.1: convert any thrown value into a RemoteMcpError. Used by the
 * outermost catch in `callRemoteTool` so the dispatcher's exhaustive switch
 * is sound — no plain `Error` (undici, AbortError, JSON parse) escapes.
 */
function toRemoteMcpError(e: unknown, mcpUrl: string): RemoteMcpError {
  if (e instanceof RemoteMcpError) return e;
  if (e instanceof Error) {
    // AbortError fires for both --timeout and SIGINT; the caller distinguishes
    // via the AbortSignal.reason it set, but the SDK swallows that. Fall back
    // to message inspection for the timeout sub-kind.
    const isAbort = e.name === 'AbortError' || /abort/i.test(e.message);
    if (isAbort) {
      return new RemoteMcpError(
        'network',
        `Request to ${mcpUrl} aborted: ${e.message}`,
        { mcp_url: mcpUrl, kind: 'aborted' },
      );
    }
    // undici/fetch network errors (DNS, connection refused, TLS) end up here.
    return new RemoteMcpError(
      'network',
      `Network error talking to ${mcpUrl}: ${e.message}`,
      { mcp_url: mcpUrl, kind: 'unreachable' },
    );
  }
  return new RemoteMcpError(
    'network',
    `Unknown error talking to ${mcpUrl}: ${String(e)}`,
    { mcp_url: mcpUrl, kind: 'unreachable' },
  );
}

/**
 * v0.31.1: parse a tool_error content envelope and extract a structured
 * `code` (e.g. 'missing_scope') if the server provided one. Tries JSON-parsed
 * payload first, then falls back to substring detection on the message.
 */
function extractToolErrorCode(message: string): string | undefined {
  // Try to parse a JSON payload first — gbrain server-side tool errors
  // sometimes come through as `{"error":{"code":"...","message":"..."}}`.
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === 'object') {
      const code = (parsed as any).error?.code ?? (parsed as any).code;
      if (typeof code === 'string') return code;
    }
  } catch { /* not json; fall through */ }
  if (/missing[_\s-]?scope|scope.+(insufficient|required)|forbidden|access.+denied/i.test(message)) {
    return 'missing_scope';
  }
  return undefined;
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

  const tokenRes = await mintClientCredentialsToken(disco.metadata.token_endpoint, remote.oauth_client_id, secret);
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
 *
 * v0.31.1: optional AbortSignal threaded into `requestInit` so callers can
 * cancel in-flight HTTP requests on timeout or SIGINT.
 */
async function buildClient(mcpUrl: string, accessToken: string, signal?: AbortSignal): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
      ...(signal ? { signal } : {}),
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
 * v0.31.1: options for `callRemoteTool`. Both fields optional; when absent the
 * call inherits SDK defaults (no client-side timeout, no abort).
 */
export interface CallRemoteToolOptions {
  /** Hard wall-clock cap for the whole call (token mint + tool call). Aborts on expiry. */
  timeoutMs?: number;
  /** External AbortSignal (e.g. SIGINT handler). Composed with the timeout. */
  signal?: AbortSignal;
}

/**
 * Compose an external signal with a timeout into a single AbortController.
 * Returns the controller (so callers can pass `controller.signal` to
 * downstream fetch) plus a `cleanup` to stop the timer + drop listeners.
 */
function buildAbortController(opts: CallRemoteToolOptions): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];

  if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
    const timer = setTimeout(() => {
      controller.abort(new Error(`timeout after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    cleanups.push(() => clearTimeout(timer));
  }

  if (opts.signal) {
    if (opts.signal.aborted) {
      controller.abort(opts.signal.reason);
    } else {
      const onAbort = () => controller.abort(opts.signal!.reason);
      opts.signal.addEventListener('abort', onAbort);
      cleanups.push(() => opts.signal!.removeEventListener('abort', onAbort));
    }
  }

  return { signal: controller.signal, cleanup: () => cleanups.forEach(fn => { try { fn(); } catch { /* best-effort */ } }) };
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
  opts: CallRemoteToolOptions = {},
): Promise<unknown> {
  const remote = requireRemoteMcp(config);

  // v0.31.1 (CDX-4): wrap the WHOLE call in normalize-on-error so the
  // exhaustive switch on RemoteMcpError.reason at the dispatcher is sound.
  // No plain Error (undici, AbortError, JSON parse) escapes.
  const { signal, cleanup } = buildAbortController(opts);
  try {
    // Step 1: mint (or reuse cached) token. If THIS fails — bad credentials,
    // unreachable issuer, etc. — surface immediately. Retry-on-401 is for
    // the mid-session token-rotation case, NOT for initial-credentials-wrong.
    const initialToken = await getAccessToken(config, false);

    // Step 2: try the tool call. On a 401-shaped failure here, drop the cache
    // and retry ONCE with a freshly-minted token (handles host-side rotation
    // mid-session). If the retry also fails auth, surface auth_after_refresh.
    const tryCall = async (token: string): Promise<unknown> => {
      const client = await buildClient(remote.mcp_url, token, signal);
      try {
        const res = await client.callTool({ name: toolName, arguments: args });
        if (res.isError) {
          const message = Array.isArray(res.content)
            ? res.content.map((c: unknown) => (c as { text?: string }).text ?? '').join('\n')
            : 'unknown tool error';
          // v0.31.1: extract structured error code (e.g. 'missing_scope') so
          // the dispatcher can produce a pinpoint hint instead of a generic
          // "tool error" message.
          const code = extractToolErrorCode(message);
          throw new RemoteMcpError(
            'tool_error',
            `Remote tool ${toolName} failed: ${message}`,
            { mcp_url: remote.mcp_url, ...(code ? { code } : {}) },
          );
        }
        return res;
      } finally {
        try { await client.close(); } catch { /* best-effort */ }
      }
    };

    try {
      return await tryCall(initialToken);
    } catch (e) {
      // RemoteMcpError already-typed: bubble unless it's a tool_error that
      // happens to look 401-shaped (e.g. SDK wrapping HTTP 401 in a tool
      // error). For plain Error, do the 401 sniff.
      const message = e instanceof Error ? e.message : String(e);
      const looksLike401 = /401|unauthor|invalid.token/i.test(message);
      if (!looksLike401) throw e;
      // Drop cached token and retry once with a fresh mint.
      tokenCache.delete(remote.mcp_url);
      let freshToken: string;
      try {
        freshToken = await getAccessToken(config, true);
      } catch (mintErr) {
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
        const m2 = e2 instanceof Error ? e2.message : String(e2);
        if (/401|unauthor|invalid.token/i.test(m2)) {
          throw new RemoteMcpError(
            'auth_after_refresh',
            `Auth failed after token refresh. Verify oauth_client_id and secret are still valid; the host operator may need to re-run \`gbrain auth register-client\`.`,
            { mcp_url: remote.mcp_url },
          );
        }
        throw e2;
      }
    }
  } catch (e) {
    // CDX-4: this is the funnel. ANYTHING that escapes the inner block becomes
    // a typed RemoteMcpError. The dispatcher's exhaustive switch can rely on
    // this contract.
    throw toRemoteMcpError(e, remote.mcp_url);
  } finally {
    cleanup();
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
