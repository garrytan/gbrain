/**
 * The warm CLI socket's wire format: newline-delimited JSON on a Unix socket,
 * one exchange per connection. The CLI sends one request; the serve answers a
 * handshake line (accepted, or refused with a reason) and then, when accepted,
 * one result line. Both directions are size-bounded.
 */
import type { Notice } from '../agent-output.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { isCliSocketIdentity, type CliSocketIdentity } from './identity.ts';

export const CLI_SOCKET_PROTOCOL = 1;
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_CAPTURED_OUTPUT_BYTES = 1024 * 1024;
export const CONNECT_TIMEOUT_MS = 150;
export const HANDSHAKE_TIMEOUT_MS = 1_000;
export const REQUEST_READ_TIMEOUT_MS = 2_000;
/** The cold path's read wallclock (src/cli/main.ts READ_OP_TIMEOUT_MS) when --timeout is not given. */
export const DEFAULT_READ_WALLCLOCK_MS = 180_000;
/** The longest a CLI waits on one whole exchange (or its --timeout, when shorter) before running the call itself. */
export const MAX_ROUND_TRIP_MS = 30_000;

/**
 * GBRA-156: a warm call that reached its round-trip cap answers with this retryable `timeout` error instead of
 * running the call again on the cold path. The serve sends it after cancelling the request's remaining work; the CLI
 * builds the same error when the serve never answered in time.
 */
export function warmRoundTripTimeout(command: string, ms: number, side: 'serve' | 'cli'): OperationError {
  return opError('timeout', `gbrain ${command} did not finish within ${ms} ms on the warm CLI socket${side === 'serve' ? '; the serve cancelled it' : ' (the serve did not answer)'}.`,
    'Retry the same command; pass --timeout <ms> to bound it. If it keeps timing out, look in the serve\'s stderr log for a request still running.',
    { reason: 'cli_socket_round_trip_cap', retryable: true, docs: 'docs/guides/cli-socket.md',
      why: `The warm CLI socket caps one call at ${ms} ms so a caller never waits on a request without a bound; the call returned this error instead of starting over on the slower cold path.` });
}

/** The read operations a serve answers over the socket. Everything else keeps the cold path. */
export const CLI_SOCKET_OPS = ['search', 'query', 'get_page'] as const;
export type CliSocketOp = typeof CLI_SOCKET_OPS[number];

export interface CliSocketRouting {
  /** The CLI's working directory (dotfile walk and registered-path tiers). */
  cwd: string;
  /** The CLI's GBRAIN_SOURCE; null when unset. */
  source_env: string | null;
}

export type CliSocketRequest = {
  v: 1;
  identity: CliSocketIdentity;
  /** The command word the cold path would print in its timeout line. */
  command: string;
  routing: CliSocketRouting;
  cli: { quiet: boolean; timeout_ms: number | null };
} & ({ kind: 'op'; op: CliSocketOp; params: Record<string, unknown> } | { kind: 'recall'; args: string[] });

/**
 * GBRA-175: a handshake-only probe. The serve checks the identity exactly as for a request and answers the handshake
 * line alone, running nothing, so `gbrain upgrade` can prove after a restart that the serve accepts this build.
 */
export interface CliSocketProbe { v: 1; kind: 'probe'; identity: CliSocketIdentity }

export function isCliSocketProbe(value: unknown): value is CliSocketProbe {
  return record(value) && value.v === CLI_SOCKET_PROTOCOL && value.kind === 'probe' && isCliSocketIdentity(value.identity);
}

/** A refusal for `identity_mismatch` names the identity part that differed in `mismatch` (cliSocketIdentityMismatch), never its value. */
export type HandshakeFrame = { v: 1; accepted: true } | { v: 1; accepted: false; reason: string; mismatch?: string };

export type OutputChunk = ['stdout' | 'stderr', string];

/** What every answered frame carries: the output to replay and the first source resolved (pinned in fix commands). */
interface Answered { output: OutputChunk[]; source?: string | null }

export type ResultFrame =
  | { v: 1; kind: 'result'; result: unknown; meta: Record<string, unknown> | null; notices: Notice[] } & Answered
  | { v: 1; kind: 'error'; error: Record<string, unknown> } & Answered
  | { v: 1; kind: 'fallback'; reason: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shape check for the serve's handshake line. */
export function isHandshakeFrame(value: unknown): value is HandshakeFrame {
  if (!record(value) || value.v !== CLI_SOCKET_PROTOCOL) return false;
  return value.accepted === true
    || (value.accepted === false && typeof value.reason === 'string' && (value.mismatch === undefined || typeof value.mismatch === 'string'));
}

function isAnswered(value: Record<string, unknown>): boolean {
  return Array.isArray(value.output)
    && value.output.every(chunk => Array.isArray(chunk) && chunk.length === 2 && (chunk[0] === 'stdout' || chunk[0] === 'stderr') && typeof chunk[1] === 'string')
    && (value.source === undefined || value.source === null || typeof value.source === 'string');
}

/** Shape check for the serve's result line: every field the CLI reads, per kind; anything else is malformed. */
export function isResultFrame(value: unknown): value is ResultFrame {
  if (!record(value) || value.v !== CLI_SOCKET_PROTOCOL) return false;
  switch (value.kind) {
    case 'result':
      return 'result' in value && (value.meta === null || record(value.meta))
        && Array.isArray(value.notices) && value.notices.every(notice => record(notice) && typeof notice.code === 'string' && typeof notice.kind === 'string' && typeof notice.why === 'string')
        && isAnswered(value);
    case 'error':
      return record(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string' && isAnswered(value);
    case 'fallback':
      return typeof value.reason === 'string';
    default:
      return false;
  }
}

/** Shape check for an inbound request; anything else is refused before it reaches the engine. */
export function isCliSocketRequest(value: unknown): value is CliSocketRequest {
  if (!record(value) || value.v !== CLI_SOCKET_PROTOCOL || !isCliSocketIdentity(value.identity) || typeof value.command !== 'string') return false;
  const routing = value.routing;
  if (!record(routing) || typeof routing.cwd !== 'string' || !routing.cwd.startsWith('/')
    || !(routing.source_env === null || typeof routing.source_env === 'string')) return false;
  const cli = value.cli;
  if (!record(cli) || typeof cli.quiet !== 'boolean'
    || !(cli.timeout_ms === null || typeof cli.timeout_ms === 'number' && Number.isFinite(cli.timeout_ms) && cli.timeout_ms > 0)) return false;
  if (value.kind === 'op') return (CLI_SOCKET_OPS as readonly unknown[]).includes(value.op) && record(value.params);
  if (value.kind === 'recall') return Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string');
  return false;
}

/** An OperationError's own fields, so the CLI can rebuild the same error and render it with the cold path's renderer. */
export function serializeOperationError(error: OperationError): Record<string, unknown> {
  const { stack: _stack, ...own } = Object.assign({}, error) as unknown as Record<string, unknown>;
  return JSON.parse(JSON.stringify({ ...own, message: error.message }));
}

export function reviveOperationError(fields: Record<string, unknown>): OperationError {
  const { code, message, suggestion, docs, name: _name, ...rest } = fields;
  const error = new OperationError(code as OperationError['code'], String(message),
    typeof suggestion === 'string' ? suggestion : undefined, typeof docs === 'string' ? docs : undefined);
  return Object.assign(error, rest);
}

/** Accumulates one newline-terminated frame from a stream, refusing past `max` bytes. */
export class FrameReader {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private rest: Buffer = Buffer.alloc(0);
  constructor(private readonly max: number) {}

  /** Feeds data; returns the completed frames' text, or 'overflow'. */
  push(data: Buffer): string[] | 'overflow' {
    let buffer = this.rest.length ? Buffer.concat([this.rest, data]) : data;
    this.rest = Buffer.alloc(0);
    const frames: string[] = [];
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline === -1) break;
      const piece = buffer.subarray(0, newline);
      this.bytes += piece.length;
      if (this.bytes > this.max) return 'overflow';
      this.chunks.push(piece);
      frames.push(Buffer.concat(this.chunks).toString('utf8'));
      this.chunks = [];
      this.bytes = 0;
      buffer = buffer.subarray(newline + 1);
    }
    this.bytes += buffer.length;
    if (this.bytes > this.max) return 'overflow';
    if (buffer.length) this.chunks.push(Buffer.from(buffer));
    return frames;
  }
}
