/**
 * The thin-client error class and the tool-result envelope readers that a
 * local CLI command also names (instanceof checks, ignored-param warnings),
 * split out of mcp-client.ts so naming them never loads the MCP SDK types and
 * zod schema graph behind a remote call. mcp-client.ts re-exports all of it.
 */
import { canonicalCodeFor } from './error-catalogue.ts';
import { publicWriteReceipt, type WriteErrorCode, type WriteReceipt } from './persistence/types.ts';

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
