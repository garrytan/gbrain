/**
 * The Google token socket's wire contract (seam v4). One JSON object per line,
 * one request and one reply per line, connections reusable. Every request
 * carries `"v":4`; versions 1 to 3 are refused with `unsupported_version`
 * because a v3 broker would silently ignore an `owner_verdict`.
 *
 * Ops: `mint` (a read-only access token), `call` (the broker makes one
 * allowlisted Google MCP call with a write-capable token it never hands out),
 * `status` (an intent's durable state) and `tools` (Google's tools/list for a
 * server, filtered to what `call` accepts). docs/guides/google-socket.md.
 */
import type { Actor } from '../agent-output.ts';

export const GOOGLE_SOCKET_VERSION = 4;
export const GOOGLE_MCP_PROTOCOL_VERSION = '2026-07-28';
export const MAX_FRAME_BYTES = 1_048_576;
export const MAX_TURN_ID_CHARS = 128;
export const GOOGLE_SERVERS = ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'slides', 'tasks'] as const;
export type GoogleServer = typeof GOOGLE_SERVERS[number];
export const DOCS_ANCHOR = 'docs/guides/google-socket.md#error-codes';

export type Recovery = 'wait' | 'fix_and_retry' | 'ask_human' | 'reconcile_first';

export type SocketErrorCode =
  | 'malformed_request' | 'unsupported_version' | 'unknown_op' | 'peer_refused'
  | 'act_not_mintable' | 'not_connected' | 'revoked' | 'insufficient_scope' | 'client_not_agent' | 'client_user_mismatch' | 'write_scope_refused'
  | 'rate_limited' | 'broker_precondition_unmet' | 'tool_not_allowed' | 'broker_args_refused'
  | 'input_required' | 'owner_confirm_required' | 'verdict_expired' | 'verdict_mismatch' | 'verdict_already_answered'
  | 'turn_cap' | 'day_cap' | 'outcome_unknown' | 'tool_error' | 'idempotency_conflict' | 'intent_unknown'
  | 'upstream' | 'internal';

const CODE_TABLE: Record<SocketErrorCode, { recovery: Recovery; actor: Actor }> = {
  malformed_request: { recovery: 'fix_and_retry', actor: 'agent' },
  unsupported_version: { recovery: 'fix_and_retry', actor: 'agent' },
  unknown_op: { recovery: 'fix_and_retry', actor: 'agent' },
  peer_refused: { recovery: 'ask_human', actor: 'host_admin' },
  act_not_mintable: { recovery: 'fix_and_retry', actor: 'agent' },
  not_connected: { recovery: 'ask_human', actor: 'user' },
  revoked: { recovery: 'ask_human', actor: 'user' },
  insufficient_scope: { recovery: 'ask_human', actor: 'user' },
  client_not_agent: { recovery: 'ask_human', actor: 'user' },
  client_user_mismatch: { recovery: 'ask_human', actor: 'user' },
  write_scope_refused: { recovery: 'ask_human', actor: 'user' },
  rate_limited: { recovery: 'wait', actor: 'agent' },
  broker_precondition_unmet: { recovery: 'ask_human', actor: 'host_admin' },
  tool_not_allowed: { recovery: 'fix_and_retry', actor: 'agent' },
  broker_args_refused: { recovery: 'fix_and_retry', actor: 'agent' },
  input_required: { recovery: 'ask_human', actor: 'user' },
  owner_confirm_required: { recovery: 'ask_human', actor: 'user' },
  verdict_expired: { recovery: 'fix_and_retry', actor: 'agent' },
  verdict_mismatch: { recovery: 'fix_and_retry', actor: 'agent' },
  verdict_already_answered: { recovery: 'fix_and_retry', actor: 'agent' },
  turn_cap: { recovery: 'ask_human', actor: 'user' },
  day_cap: { recovery: 'wait', actor: 'agent' },
  outcome_unknown: { recovery: 'reconcile_first', actor: 'agent' },
  tool_error: { recovery: 'ask_human', actor: 'provider' },
  idempotency_conflict: { recovery: 'fix_and_retry', actor: 'agent' },
  intent_unknown: { recovery: 'fix_and_retry', actor: 'agent' },
  upstream: { recovery: 'wait', actor: 'provider' },
  internal: { recovery: 'ask_human', actor: 'host_admin' },
};

export interface QuotaView { product: GoogleServer; used_today: number; cap: number; day: string }

export interface SocketFailure {
  v: 4; ok: false; code: SocketErrorCode; message: string; request_id: string; recovery: Recovery; actor: Actor; docs: string;
  retry_after_s?: number; [extra: string]: unknown;
}

export class SocketError extends Error {
  constructor(public readonly code: SocketErrorCode, message: string, public readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SocketError';
  }
}

export function failure(requestId: string, code: SocketErrorCode, message: string, extra: Record<string, unknown> = {}): SocketFailure {
  const { recovery, actor } = CODE_TABLE[code];
  return { v: GOOGLE_SOCKET_VERSION, ok: false, code, message, request_id: requestId, recovery, actor, docs: DOCS_ANCHOR, ...extra };
}

export interface MintRequest { op: 'mint'; account: string; profile: string; caller: string; fresh?: boolean }
export interface OwnerVerdict { choice: 'ALLOW_ONCE'; for_request: string }
export interface CallRequest {
  op: 'call'; account: string; server: GoogleServer; tool: string; args: Record<string, unknown>;
  turn_id: string; idempotency_key: string; caller: string; owner_verdict?: OwnerVerdict;
}
export interface StatusRequest { op: 'status'; idempotency_key: string }
export interface ToolsRequest { op: 'tools'; account: string; server: GoogleServer }
/** Owner-only: answers a held prompt from the isolated channel (`gbrain google approvals answer`). */
export interface VerdictRequest { op: 'verdict'; request_id: string; choice: string }
/** Owner-only: lists held prompts. */
export interface PendingRequest { op: 'pending' }
export type SocketRequest = MintRequest | CallRequest | StatusRequest | ToolsRequest | VerdictRequest | PendingRequest;

const PRINTABLE = /^[\x20-\x7e]+$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Record<string, unknown>, k: string, max = 320): string => {
  const v = o[k];
  if (typeof v !== 'string' || v.length === 0 || v.length > max || !PRINTABLE.test(v)) throw new SocketError('malformed_request', `"${k}" must be a non-empty printable string of at most ${max} characters`);
  return v;
};
const server = (o: Record<string, unknown>): GoogleServer => {
  const s = str(o, 'server', 32);
  if (!(GOOGLE_SERVERS as readonly string[]).includes(s)) throw new SocketError('tool_not_allowed', `server "${s}" is not one of ${GOOGLE_SERVERS.join(', ')} (Chat is not served)`);
  return s as GoogleServer;
};

/** Validates one parsed frame into a request, or throws a SocketError naming the field. */
export function parseRequest(raw: unknown): SocketRequest {
  if (!isObj(raw)) throw new SocketError('malformed_request', 'a request is one JSON object per line');
  if (raw.v !== GOOGLE_SOCKET_VERSION) {
    throw new SocketError('unsupported_version', `this socket speaks protocol v${GOOGLE_SOCKET_VERSION}; got v${JSON.stringify(raw.v ?? null)}`, { supported: [GOOGLE_SOCKET_VERSION] });
  }
  switch (raw.op) {
    case 'mint': return { op: 'mint', account: str(raw, 'account').toLowerCase(), profile: str(raw, 'profile', 16), caller: str(raw, 'caller', 64), ...(raw.fresh === true ? { fresh: true } : {}) };
    case 'call': {
      if (!isObj(raw.args)) throw new SocketError('malformed_request', '"args" must be an object');
      let verdict: OwnerVerdict | undefined;
      if (raw.owner_verdict !== undefined) {
        if (!isObj(raw.owner_verdict)) throw new SocketError('malformed_request', '"owner_verdict" must be an object');
        if (raw.owner_verdict.choice !== 'ALLOW_ONCE') throw new SocketError('broker_args_refused', 'owner_verdict carries ALLOW_ONCE only; durable choices go through gbrain google approvals');
        verdict = { choice: 'ALLOW_ONCE', for_request: str(raw.owner_verdict, 'for_request', 64) };
      }
      return {
        op: 'call', account: str(raw, 'account').toLowerCase(), server: server(raw), tool: str(raw, 'tool', 96), args: raw.args,
        turn_id: str(raw, 'turn_id', MAX_TURN_ID_CHARS), idempotency_key: str(raw, 'idempotency_key', 128), caller: str(raw, 'caller', 64),
        ...(verdict ? { owner_verdict: verdict } : {}),
      };
    }
    case 'status': return { op: 'status', idempotency_key: str(raw, 'idempotency_key', 128) };
    case 'tools': return { op: 'tools', account: str(raw, 'account').toLowerCase(), server: server(raw) };
    case 'verdict': return { op: 'verdict', request_id: str(raw, 'request_id', 64), choice: str(raw, 'choice', 64) };
    case 'pending': return { op: 'pending' };
    default: throw new SocketError('unknown_op', `op must be mint, call, status or tools; got ${JSON.stringify(raw.op ?? null)}`);
  }
}

/** Splits a byte stream into newline-terminated frames, refusing one longer than the cap. */
export class LineReader {
  private buf = '';
  constructor(private readonly max: number = MAX_FRAME_BYTES) {}
  push(chunk: string): string[] | 'overflow' {
    this.buf += chunk;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) out.push(line);
    }
    return Buffer.byteLength(this.buf) > this.max ? 'overflow' : out;
  }
}
