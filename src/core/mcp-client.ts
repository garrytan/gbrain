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
 * HTTP 401 handling: drop the cached token, mint fresh once, retry the call.
 * Application errors and other HTTP statuses are terminal. If the refreshed
 * attempt is also rejected with HTTP 401, surface auth_after_refresh.
 */

import { randomUUID } from 'node:crypto';
import { isPersistenceIpcMutation } from './persistence/ipc.ts';
import { replayWhilePending } from './persistence/write-wait.ts';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { anySignal } from './abort-check.ts';
import { canonicalCodeFor } from './error-catalogue.ts';
import type { GBrainConfig } from './config.ts';
import { discoverOAuth, mintClientCredentialsToken } from './remote-mcp-probe.ts';
import { isWriteErrorCode, isWriteReceipt, isWriteRequestId, publicWriteReceipt, type WriteErrorCode, type WriteReceipt } from './persistence/types.ts';
import { GBRAIN_CLIENT_HEADER, GBRAIN_THIN_CLIENT_NAME } from '../mcp/result-rows.ts';
import { VERSION } from '../version.ts';

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
  /** OAuth /token answered 429; `detail.retry_after_s` carries its Retry-After. */
  | 'rate_limited'
  /** OAuth /token failed after discovery succeeded (non-auth HTTP status or bad body). */
  | 'token'
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
  /** Seconds the server asked us to wait before minting again (rate_limited). */
  retry_after_s?: number;
  /** An accepted mutation's receipt survives the transport's tool-error wrapper. */
  write_request?: WriteReceipt;
  write_error?: WriteErrorCode;
  /** Retained even when no acknowledgment proves whether the write was accepted. */
  request_id?: string;
  submission_status?: 'unknown' | 'not_sent';
  message?: string;
  suggestion?: string;
  protocol_version?: 1;
  server_detail?: string;
  docs?: string;
  /** Agent contract v1: canonical registry code (`code`) when it differs from or adds to the wire `error` (kept in `code` above). */
  canonical_code?: string;
  reason?: string;
  why?: string;
  /** Rendered fix as the server sent it (`next` included). */
  fix?: Record<string, unknown>;
  /** Notices from the envelope's `notices` key (error results carry exactly one block). */
  notices?: Array<Record<string, unknown>>;
  contract_version?: 1;
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

  /** Mutation error output shares the CLI/IPC envelope without inventing a receipt. */
  toJSON() {
    const detail = this.detail;
    const unknown = detail?.submission_status === 'unknown';
    const wire = detail?.code ?? 'unavailable';
    return {
      error: wire,
      code: detail?.canonical_code ?? canonicalCodeFor(wire),
      message: detail?.message ?? this.message,
      ...(detail?.request_id ? { request_id: detail.request_id } : {}),
      ...(detail?.submission_status ? { submission_status: detail.submission_status } : {}),
      ...(unknown ? { detail: 'delivery_unknown' } : detail?.server_detail ? { detail: detail.server_detail } : {}),
      suggestion: detail?.suggestion ?? (detail?.request_id
        ? `${unknown ? 'Submission state is unknown. ' : ''}Retry the same operation and arguments with request_id ${detail.request_id}; do not generate a replacement ID.`
        : 'Inspect the remote connection before retrying.'),
      ...(detail?.protocol_version === 1 ? { protocol_version: 1 } : {}),
      ...(detail?.docs ? { docs: detail.docs } : {}),
      ...(detail?.write_request ? { write_request: publicWriteReceipt(detail.write_request) } : {}),
      ...(detail?.write_error ? { write_error: detail.write_error } : {}),
      ...(detail?.reason ? { reason: detail.reason } : {}),
      ...(detail?.why ? { why: detail.why } : {}),
      ...(detail?.fix ? { fix: detail.fix } : {}),
      ...(detail?.notices?.length ? { notices: detail.notices } : {}),
      ...(detail?.contract_version === 1 ? { contract_version: 1 } : {}),
    };
  }
}

/**
 * B5 (#5949): a 429 on the /token mint is the host's mint budget, not a
 * connectivity fault: code `rate_limited`, a provider-side wait, and the
 * read-only check to run once the wait is over.
 */
function rateLimitedMintDetail(retryAfterS: number | undefined): RemoteMcpErrorDetail {
  const wait = retryAfterS !== undefined ? `${retryAfterS}s` : 'a few minutes';
  return {
    code: 'rate_limited',
    why: `The brain host's OAuth /token mint budget is spent (HTTP 429); it clears by itself in ${wait}.`,
    suggestion: `Wait ${wait}, then re-run the same command. If this repeats, the host operator can raise GBRAIN_OAUTH_TOKEN_RATE_LIMIT_MAX.`,
    fix: {
      argv: ['gbrain', 'remote', 'doctor', '--json'], consent: [], actor: 'provider',
      why: `Retry after ${wait}; remote doctor confirms the token mint works again.`, requires_exclusive: false,
    },
  };
}

type HttpClientSdk = typeof import('@modelcontextprotocol/sdk/client/index.js')
  & typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js');
let httpClientSdk: HttpClientSdk | undefined;

/**
 * The SDK's client + Streamable HTTP transport, loaded by the first remote
 * call (buildClient). Only thin-client calls use them, so a local CLI command
 * never pays for their import graph.
 */
async function loadHttpClientSdk(): Promise<HttpClientSdk> {
  httpClientSdk ??= {
    ...(await import('@modelcontextprotocol/sdk/client/index.js')),
    ...(await import('@modelcontextprotocol/sdk/client/streamableHttp.js')),
  };
  return httpClientSdk;
}

/** A transport error: only possible once loadHttpClientSdk has loaded the transport that throws it. */
function isStreamableHttpError(e: unknown): e is StreamableHTTPError {
  return httpClientSdk !== undefined && e instanceof httpClientSdk.StreamableHTTPError;
}

/**
 * v0.31.1: convert any thrown value into a RemoteMcpError. Used by the
 * outermost catch in `callRemoteTool` so the dispatcher's exhaustive switch
 * is sound — no plain `Error` (undici, AbortError, JSON parse) escapes.
 *
 * @internal Exported for test access (test/mcp-client-hardening.test.ts).
 * Not part of the public API — production code should consume this only via
 * the callRemoteTool funnel.
 */
export function toRemoteMcpError(e: unknown, mcpUrl: string, signal?: AbortSignal): RemoteMcpError {
  // A received receipt is stronger evidence than a deadline that fired while
  // unwinding the call. Losing it invites a second mutation after acceptance.
  if (e instanceof RemoteMcpError && e.detail?.write_request) return e;
  if (signal?.aborted) {
    const kind = signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
      ? 'timeout' : 'aborted';
    return new RemoteMcpError(
      'network',
      `Request to ${mcpUrl} ${kind === 'timeout' ? 'timed out' : 'was aborted'}`,
      { mcp_url: mcpUrl, kind },
    );
  }
  if (e instanceof RemoteMcpError) return e;
  // The SDK's own request timer can fire while our composed signal is still
  // live. A slow operation on a reachable server is a timeout, not unreachable.
  if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) {
    return new RemoteMcpError('network', `Request to ${mcpUrl} timed out`, { mcp_url: mcpUrl, kind: 'timeout' });
  }
  if (e instanceof Error) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      return new RemoteMcpError(
        'network',
        `Request to ${mcpUrl} ${e.name === 'TimeoutError' ? 'timed out' : 'was aborted'}`,
        { mcp_url: mcpUrl, kind: e.name === 'TimeoutError' ? 'timeout' : 'aborted' },
      );
    }
    // undici/fetch network errors (DNS, connection refused, TLS) end up here.
    return new RemoteMcpError(
      'network',
      `Network error talking to ${mcpUrl}: ${e.message}`,
      {
        mcp_url: mcpUrl,
        kind: 'unreachable',
        ...(isStreamableHttpError(e) && e.code !== undefined && e.code > 0
          ? { status: e.code } : {}),
      },
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
 *
 * @internal Exported for test access (test/mcp-client-hardening.test.ts).
 */
export function extractToolErrorCode(message: string): string | undefined {
  // Try to parse a JSON payload first — gbrain server-side tool errors
  // sometimes come through as `{"error":{"code":"...","message":"..."}}`.
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === 'object') {
      const code = typeof parsed.error === 'string'
        ? parsed.error : parsed.error?.code ?? parsed.code;
      if (typeof code === 'string') return code;
    }
  } catch { /* not json; fall through */ }
  if (/missing[_\s-]?scope|scope.+(insufficient|required)|forbidden|access.+denied/i.test(message)) {
    return 'missing_scope';
  }
  return undefined;
}

/** Keep only validated public receipt fields from a tool's JSON error body. */
export function extractToolErrorDetail(message: string): RemoteMcpErrorDetail {
  const code = extractToolErrorCode(message);
  const detail: RemoteMcpErrorDetail = code ? { code } : {};
  try {
    const body: unknown = JSON.parse(message);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return detail;
    const envelope = body as Record<string, unknown>;
    if (typeof envelope.message === 'string') detail.message = envelope.message;
    if (typeof envelope.suggestion === 'string') detail.suggestion = envelope.suggestion;
    if (envelope.protocol_version === 1) detail.protocol_version = 1;
    if (typeof envelope.detail === 'string') detail.server_detail = envelope.detail;
    if (typeof envelope.docs === 'string') detail.docs = envelope.docs;
    if (typeof envelope.code === 'string' && envelope.code !== code) detail.canonical_code = envelope.code;
    if (typeof envelope.reason === 'string') detail.reason = envelope.reason;
    if (typeof envelope.why === 'string') detail.why = envelope.why;
    if (envelope.fix && typeof envelope.fix === 'object' && !Array.isArray(envelope.fix)) detail.fix = envelope.fix as Record<string, unknown>;
    if (Array.isArray(envelope.notices)) detail.notices = envelope.notices.filter(n => n && typeof n === 'object') as Array<Record<string, unknown>>;
    if (envelope.contract_version === 1) detail.contract_version = 1;
    if (isWriteReceipt(envelope.write_request)) detail.write_request = publicWriteReceipt(envelope.write_request);
    if (isWriteErrorCode(envelope.write_error)) detail.write_error = envelope.write_error;
  } catch { /* Older servers can return plain text; preserve existing code extraction. */ }
  return detail;
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
async function getAccessToken(config: GBrainConfig, force = false, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const remote = requireRemoteMcp(config);
  const cached = tokenCache.get(remote.mcp_url);
  if (!force && cached && cached.expires_at_ms > Date.now()) {
    return cached.access_token;
  }

  const secret = resolveSecret(remote);

  const disco = await discoverOAuth(remote.issuer_url, { signal });
  signal?.throwIfAborted();
  if (!disco.ok) {
    throw new RemoteMcpError(
      disco.reason === 'http' || disco.reason === 'parse' ? 'discovery' : 'network',
      `OAuth discovery failed: ${disco.message}`,
      { ...(disco.status ? { status: disco.status } : {}), ...(disco.kind ? { kind: disco.kind } : {}), mcp_url: remote.mcp_url,
        ...(disco.status_only ? { ...extractToolErrorDetail(JSON.stringify(disco.status_only)), retry_after_s: disco.retry_after_s } : {}) },
    );
  }

  const tokenRes = await mintClientCredentialsToken(disco.metadata.token_endpoint, remote.oauth_client_id, secret, { signal });
  signal?.throwIfAborted();
  if (!tokenRes.ok) {
    // Discovery already succeeded, so a /token failure is never 'discovery'.
    throw new RemoteMcpError(
      tokenRes.reason === 'http' || tokenRes.reason === 'parse' ? 'token' : tokenRes.reason,
      `OAuth /token failed: ${tokenRes.message}`,
      {
        ...(tokenRes.status ? { status: tokenRes.status } : {}), ...(tokenRes.kind ? { kind: tokenRes.kind } : {}),
        ...(tokenRes.retry_after_s !== undefined ? { retry_after_s: tokenRes.retry_after_s } : {}), mcp_url: remote.mcp_url,
        ...(tokenRes.reason === 'rate_limited' ? rateLimitedMintDetail(tokenRes.retry_after_s) : {}),
        ...(tokenRes.status_only ? extractToolErrorDetail(JSON.stringify(tokenRes.status_only)) : {}),
      },
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
 * The SDK replaces requestInit.signal with its own transport signal. Compose
 * them in fetch so cancellation covers HTTP bodies as well as SDK requests.
 */
async function buildClient(mcpUrl: string, accessToken: string, signal?: AbortSignal): Promise<Client> {
  const { Client, StreamableHTTPClientTransport } = await loadHttpClientSdk();
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        // Hosts serve full search/query rows to gbrain's own CLI (renderers,
        // --explain). A row-shape hint only, never an authority claim.
        [GBRAIN_CLIENT_HEADER]: `${GBRAIN_THIN_CLIENT_NAME}/${VERSION}`,
      },
    },
    fetch: (input, init) => fetch(input, {
      ...init,
      signal: signal ? anySignal(signal, init?.signal) : init?.signal,
    }),
  });
  const client = new Client(
    { name: GBRAIN_THIN_CLIENT_NAME, version: '1' },
    { capabilities: {} },
  );
  try {
    signal?.throwIfAborted();
    await client.connect(transport, { signal });
    return client;
  } catch (error) {
    try { await client.close(); } catch { /* best-effort */ }
    // Also close when connect failed before attaching the transport.
    try { await transport.close(); } catch { /* best-effort */ }
    throw error;
  }
}

/**
 * Options for `callRemoteTool`. When absent, discovery/token requests retain
 * their own caps and MCP requests inherit the SDK's timeout. A `timeoutMs`
 * also becomes the SDK request deadline (see buildMcpRequestOptions).
 */
export interface CallRemoteToolOptions {
  /** Hard wall-clock cap for the whole call (token mint + tool call). Aborts on expiry. */
  timeoutMs?: number;
  /** External AbortSignal (e.g. SIGINT handler). Composed with the timeout. */
  signal?: AbortSignal;
  /**
   * #5232: keep a mutation's commit wait beyond the server's own bounded
   * wait by replaying the identical request (same request_id) while it is
   * pending. `timeoutMs` still bounds each exchange.
   */
  writeWaitMs?: number;
}

/**
 * The SDK request options for one tool call. Passing only `signal` leaves the
 * SDK's independent 60s default deadline in force, so a caller's longer
 * timeout would still die at 60s; forward it.
 *
 * @internal Exported for test access (test/mcp-client-hardening.test.ts).
 */
export function buildMcpRequestOptions(opts: CallRemoteToolOptions, signal: AbortSignal): { signal: AbortSignal; timeout?: number } {
  return { signal, ...(opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? { timeout: opts.timeoutMs } : {}) };
}

/**
 * Compose an external signal with a timeout into a single AbortController.
 * Returns the controller (so callers can pass `controller.signal` to
 * downstream fetch) plus a `cleanup` to stop the timer + drop listeners.
 */
/** @internal Exported for test access (test/mcp-client-hardening.test.ts). */
export function buildAbortController(opts: CallRemoteToolOptions): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];

  if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
    const timer = setTimeout(() => {
      controller.abort(new DOMException(`timeout after ${opts.timeoutMs}ms`, 'TimeoutError'));
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
 * Returns the parsed `result` payload from the tool response. Mutation calls
 * retain a generated request_id on args for refresh and caller retries.
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
  // Retain on the caller's object so transport refresh and caller retries use
  // the same durable identity. Explicit malformed IDs still reach validation.
  if (isPersistenceIpcMutation(toolName) && args.request_id === undefined && args.dry_run !== true) args.request_id = randomUUID();
  if (opts.writeWaitMs !== undefined && isPersistenceIpcMutation(toolName) && args.dry_run !== true) {
    const { writeWaitMs, ...exchange } = opts;
    return replayWhilePending(() => callRemoteTool(config, toolName, args, exchange), writeWaitMs);
  }
  const requestId = isPersistenceIpcMutation(toolName) && isWriteRequestId(args.request_id) ? args.request_id : undefined;
  let submitted = false;

  // v0.31.1 (CDX-4): wrap the WHOLE call in normalize-on-error so the
  // exhaustive switch on RemoteMcpError.reason at the dispatcher is sound.
  // No plain Error (undici, AbortError, JSON parse) escapes.
  const { signal, cleanup } = buildAbortController(opts);
  try {
    // Step 1: mint (or reuse cached) token. If THIS fails — bad credentials,
    // unreachable issuer, etc. — surface immediately. Retry-on-401 is for
    // the mid-session token-rotation case, NOT for initial-credentials-wrong.
    const initialToken = await getAccessToken(config, false, signal);

    // Step 2: try the tool call. On an HTTP 401 here, drop the cache
    // and retry ONCE with a freshly-minted token (handles host-side rotation
    // mid-session). If the retry also fails auth, surface auth_after_refresh.
    const tryCall = async (token: string): Promise<unknown> => {
      const client = await buildClient(remote.mcp_url, token, signal);
      try {
        signal.throwIfAborted();
        submitted = true;
        const res = await client.callTool({ name: toolName, arguments: args }, undefined, buildMcpRequestOptions(opts, signal));
        if (res.isError) {
          // Agent contract v1: the envelope is content[0] alone. A notice
          // block from a newer server never joins the body.
          const first = Array.isArray(res.content) ? (res.content[0] as { text?: unknown } | undefined) : undefined;
          const message = typeof first?.text === 'string' ? first.text : 'unknown tool error';
          // v0.31.1: extract structured error code (e.g. 'missing_scope') so
          // the dispatcher can produce a pinpoint hint instead of a generic
          // "tool error" message.
          throw new RemoteMcpError(
            'tool_error',
            `Remote tool ${toolName} failed: ${message}`,
            { mcp_url: remote.mcp_url, ...extractToolErrorDetail(message) },
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
      // A response received before cleanup is authoritative even if closing
      // the transport crosses the deadline. Preserve its receipt first.
      if (e instanceof RemoteMcpError && e.detail?.write_request) throw e;
      // Application errors can contain arbitrary text (including client IDs
      // with "401"). Only a rejected HTTP request authorizes a replay.
      signal.throwIfAborted();
      if (!isStreamableHttpError(e) || e.code !== 401) throw e;
      submitted = false; // This attempt was explicitly refused, not accepted.
      // Drop cached token and retry once with a fresh mint.
      tokenCache.delete(remote.mcp_url);
      let freshToken: string;
      try {
        freshToken = await getAccessToken(config, true, signal);
      } catch (mintErr) {
        if (mintErr instanceof RemoteMcpError && mintErr.reason === 'auth') {
          throw new RemoteMcpError(
            'auth_after_refresh',
            `Auth failed after token refresh. Verify oauth_client_id and secret are still valid; the host operator may need to re-run \`gbrain auth register-client\`.`,
            { mcp_url: remote.mcp_url, ...(mintErr.detail?.status ? { status: mintErr.detail.status } : {}) },
          );
        }
        throw mintErr;
      }
      try {
        return await tryCall(freshToken);
      } catch (e2) {
        if (e2 instanceof RemoteMcpError && e2.detail?.write_request) throw e2;
        signal.throwIfAborted();
        if (isStreamableHttpError(e2) && e2.code === 401) {
          submitted = false;
          tokenCache.delete(remote.mcp_url);
          throw new RemoteMcpError(
            'auth_after_refresh',
            `Auth failed after token refresh. Verify oauth_client_id and secret are still valid; the host operator may need to re-run \`gbrain auth register-client\`.`,
            { mcp_url: remote.mcp_url, status: 401 },
          );
        }
        throw e2;
      }
    }
  } catch (e) {
    // CDX-4: this is the funnel. ANYTHING that escapes the inner block becomes
    // a typed RemoteMcpError. The dispatcher's exhaustive switch can rely on
    // this contract.
    const error = toRemoteMcpError(e, remote.mcp_url, signal);
    if (!requestId) throw error;
    throw new RemoteMcpError(error.reason, error.message, {
      ...error.detail, request_id: requestId,
      ...(!error.detail?.write_request && error.reason !== 'tool_error'
        ? { submission_status: submitted ? 'unknown' as const : 'not_sent' as const } : {}),
      ...(toolName === 'remember' || toolName === 'forget' ? { protocol_version: 1 as const } : {}),
    });
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
  // Deliberately content[0]-only (D8 skew guard): new servers append a
  // model-facing diagnosis block as content[1] on empty retrievals; the
  // structured body contract stays in block 0 and this parser must never
  // trip on the extra block. Pinned by test.
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

/**
 * Agent contract v1 notices on a SUCCESS result: `_meta.gbrain_notices`
 * (rendered) when present, else the prefixed extra text blocks after
 * content[0] (`[gbrain notice <code> kind=<kind>]` first line), for hosts
 * that drop `_meta`. Old servers return none.
 */
export function extractNotices(res: unknown): Array<Record<string, unknown>> {
  const meta = extractResponseMeta(res)?.gbrain_notices;
  if (Array.isArray(meta)) return meta.filter(n => n && typeof n === 'object') as Array<Record<string, unknown>>;
  const content = (res as { content?: unknown[] } | undefined)?.content;
  const out: Array<Record<string, unknown>> = [];
  for (const block of Array.isArray(content) ? content.slice(1) : []) {
    const text = (block as { text?: unknown })?.text;
    if (typeof text !== 'string' || !text.startsWith('[gbrain notice ')) continue;
    const [head, ...rest] = text.split('\n');
    const m = /^\[gbrain notice (\S+) kind=(\S+)\]$/.exec(head);
    if (!m) continue;
    const notice: Record<string, unknown> = { code: m[1], kind: m[2] };
    for (const line of rest) {
      const kv = /^(why|fix|next|user_message): (.*)$/.exec(line);
      if (kv) notice[kv[1]] = kv[2];
    }
    out.push(notice);
  }
  return out;
}

/**
 * T15/FOV-1: read the response-level `_meta` from a tool-call envelope
 * (see docs/protocol/MCP_META_CHANNELS.md). Old servers simply lack the
 * field — callers must treat undefined as "no meta", never as an error.
 */
export function extractResponseMeta(res: unknown): Record<string, unknown> | undefined {
  const meta = (res as { _meta?: unknown } | undefined)?._meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    return meta as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Params the server reported it ignored (WP3 warn mode): `_meta.warnings`
 * entries with code `unknown_param`, plus the model-visible warning blocks
 * after content[0] for transports that drop `_meta`. Empty for hosts that
 * predate unknown-parameter warnings, which cannot be detected.
 */
export function ignoredRemoteParams(res: unknown): string[] {
  const names = new Set<string>();
  const warnings = extractResponseMeta(res)?.warnings;
  if (Array.isArray(warnings)) {
    for (const w of warnings as Array<{ code?: unknown; param?: unknown }>) {
      if (w?.code === 'unknown_param' && typeof w.param === 'string') names.add(w.param);
    }
  }
  const content = (res as { content?: unknown[] } | undefined)?.content;
  for (const block of Array.isArray(content) ? content.slice(1) : []) {
    const text = (block as { text?: unknown })?.text;
    if (typeof text !== 'string') continue;
    for (const m of text.matchAll(/^(?:why: )?warning: unknown parameter "([^"]+)" ignored/gm)) names.add(m[1]);
  }
  return [...names];
}
