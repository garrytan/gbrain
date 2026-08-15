/**
 * Raw-bearer MCP smoke probe for `gbrain connect --install` (D4).
 *
 * Purpose-built so a bad/expired token fails at setup time instead of
 * silently on the agent's first tool call. It does the FULL handshake the
 * existing helpers do NOT:
 *   - `src/core/remote-mcp-probe.ts:smokeTestMcp` only sends `initialize`,
 *     so it can't prove a tool call actually round-trips.
 *   - `src/core/mcp-client.ts:callRemoteTool` is OAuth-only (it mints
 *     client-credentials tokens) and ignores a raw bearer token.
 *
 * This probe connects the official MCP SDK Client over StreamableHTTP with a
 * STATIC Authorization header (no OAuth, no discovery), then calls
 * `get_brain_identity` — a read-scope, non-localOnly op reachable over plain
 * bearer auth. `client.connect()` performs the `initialize` handshake and
 * owns the streamable-http session id, so the subsequent `tools/call` lands
 * on the same session without us hand-rolling session headers.
 *
 * Returns a discriminated result so the caller renders a precise warning.
 * Never throws: every failure path maps to `{ ok: false, reason, message }`.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type ConnectProbeReason = 'auth' | 'unreachable' | 'timeout' | 'tool_error' | 'unknown';

/** Default smoke-probe timeout. Single source of truth shared with connect.ts. */
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

/** Shared auth-rejection matcher so the thrown-error and tool-error paths agree. */
export function isAuthErrorMessage(message: string): boolean {
  return /\b(401|403)\b|unauthor|invalid.token|forbidden/i.test(message);
}

export type ConnectProbeResult =
  | { ok: true; identity: string }
  | { ok: false; reason: ConnectProbeReason; message: string };

/**
 * The single MCP round-trip, injectable for unit tests so the SDK + a live
 * server aren't required to exercise the result-mapping + error-classification.
 */
export interface ProbeDeps {
  connectAndCall: (
    mcpUrl: string,
    token: string,
    signal: AbortSignal,
  ) => Promise<{ isError?: boolean; content?: unknown }>;
}

/**
 * Map a thrown error message to a probe reason. Pure + exported so the
 * classification is unit-testable without a network.
 */
export function classifyProbeError(message: string): ConnectProbeReason {
  if (/timeout|abort/i.test(message)) return 'timeout';
  if (isAuthErrorMessage(message)) return 'auth';
  // undici/fetch + MCP SDK transport failures: DNS, ECONNREFUSED, TLS,
  // getaddrinfo, and the SDK's friendly "Unable to connect..." wrapper.
  if (/fetch failed|unable to connect|connection refused|failed to connect|could not connect|ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|network|socket|tls|certificate/i.test(message)) {
    return 'unreachable';
  }
  return 'unknown';
}

/** Pull the text payload out of an MCP tool result's content array. */
export function extractResultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
      ? (c as { text: string }).text
      : ''))
    .filter(Boolean)
    .join('\n');
}

const DEFAULT_DEPS: ProbeDeps = {
  connectAndCall: async (mcpUrl, token, signal) => {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      },
    });
    const client = new Client(
      { name: 'gbrain-connect-probe', version: '1' },
      { capabilities: {} },
    );
    // close() lives in a finally that wraps connect() too — if connect()
    // throws mid-handshake the transport/socket must still be torn down.
    try {
      await client.connect(transport);
      // callTool's return is a wide union (incl. the legacy {toolResult}
      // shape); we only read isError + content, so narrow at the boundary.
      const res = await client.callTool({ name: 'get_brain_identity', arguments: {} });
      return res as { isError?: boolean; content?: unknown };
    } finally {
      try { await client.close(); } catch { /* best-effort */ }
    }
  },
};

/**
 * Probe `<mcpUrl>` with the bearer token by calling `get_brain_identity`.
 * `timeoutMs` defaults to 15s (the smokeTestMcp default). Pass `deps` to stub
 * the round-trip in unit tests.
 */
export async function probeBrainIdentity(
  mcpUrl: string,
  token: string,
  opts: { timeoutMs?: number; deps?: ProbeDeps } = {},
): Promise<ConnectProbeResult> {
  const deps = opts.deps ?? DEFAULT_DEPS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Promise.race against a real timer: the AbortSignal alone does NOT cover
  // client.connect()'s initialize/SSE handshake, so a server that accepts the
  // socket then stalls before responding would hang the probe (and the whole
  // --install) forever. The race makes the timeout guarantee actually hold —
  // the abandoned connectAndCall promise settles in the background; the CLI
  // exits regardless.
  const timeoutGuard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('timeout'));
      // Message must contain "timeout" so classifyProbeError maps it correctly.
      reject(new Error(`probe timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([deps.connectAndCall(mcpUrl, token, controller.signal), timeoutGuard]);
    if (res.isError) {
      const message = extractResultText(res.content) || 'unknown tool error';
      const reason = isAuthErrorMessage(message) ? 'auth' : 'tool_error';
      return { ok: false, reason, message };
    }
    const identity = extractResultText(res.content);
    return { ok: true, identity };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: classifyProbeError(message), message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
