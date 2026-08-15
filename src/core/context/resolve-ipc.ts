/**
 * Retrieval Reflex — resolve IPC (issue #1981, D9=C) + turn-context IPC v2
 * (agent-bootstrap plan: ENG-3, A9, S3#6, G11, CX2-10).
 *
 * PGLite is single-connection: `gbrain serve` holds the one connection for its
 * lifetime, so the context engine cannot open its own and must NOT shell out to
 * a subprocess (that would force-steal the lock past the 5-min staleness window
 * and crash the brain — see plan D9 rejected option). Instead, `serve`
 * optionally listens on a local unix-domain socket and answers NARROW requests
 * using the connection it already owns. Both ends are gbrain code; raw SQL
 * never crosses the wire (closes the trust hole).
 *
 * Protocol: newline-delimited JSON. One request line, one response line.
 * Requests form a discriminated union on `kind`; ABSENT kind means 'resolve'
 * so every v1 client keeps working against a v2 server unchanged [ENG-3]:
 *
 *   resolve (v1, secret-free):
 *     req:  { kind?: 'resolve', candidates, priorContextText?, maxPointers?, sourceId? }
 *     resp: { ok: true, block: PointerBlock | null } | { ok: false, error }
 *
 *   turn_context (v2, secret-gated [S3#6], source-bound [CX2-10]):
 *     req:  { kind: 'turn_context', protocol: 2, secret, window, priorContextText?,
 *             sessionId?, sourceId?, maxBytes? }
 *     resp: { ok, protocol: 2, block?, degradedReason?, error? }
 *
 * The protocol:2 echo on every turn_context response is the stale-serve
 * detector [A9]: a v1 server answers a turn_context request as a resolve
 * request (`{ok:true, block:null}`, no echo) and the client degrades to a
 * typed { degraded: 'stale_serve' } instead of trusting the empty block.
 *
 * Local-only (unix socket in a 0700 dir on the brain's data dir, socket mode
 * 0600 set before readiness is announced) — no network surface.
 */

import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  unlinkSync,
  statSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import type { EntityCandidate } from './entity-salience.ts';
import type { WindowTurn } from './entity-salience.ts';
import type { PointerBlock } from './retrieval-reflex.ts';
import type { TurnContextResult } from './turn-context.ts';

const SOCK_NAME = '.gbrain-resolve.sock';
const SECRET_NAME = '.gbrain-ipc-secret';
/** Per-kind budgets [G11]: resolve keeps its legacy 250ms client timeout. */
const CLIENT_TIMEOUT_MS = 250;
/** turn_context does real assembly work — wider client budget (still <1s). */
export const TURN_CONTEXT_CLIENT_TIMEOUT_MS = 600;
/** Server-side self-budget for turn_context assembly (< client timeout). */
export const TURN_CONTEXT_SERVER_BUDGET_MS = 400;
/**
 * v0.45.7 ambient recall — context_pack budgets. Packs build entity CARDS
 * (heavier than turn_context's three arms), and their consumer is the
 * session-start hook (1.5s self-deadline, 5s harness timeout), so they get a
 * wider budget. The server passes its budget into the assembler as a
 * wall-clock deadline, so overrun returns a PARTIAL pack (degradedReason
 * 'deadline'), never an empty hard failure (eng 4A).
 */
export const CONTEXT_PACK_CLIENT_TIMEOUT_MS = 1000;
/** Assembler deadline. Backstop = +200; client 1000 leaves a real transport
 * margin (adversarial review: 800+200 == client timeout was zero margin). */
export const CONTEXT_PACK_SERVER_BUDGET_MS = 600;
const MAX_MSG_BYTES = 256 * 1024;

/** Marker the client returns when no server is reachable (vs. a real null result). */
export const IPC_UNAVAILABLE = Symbol('ipc-unavailable');

// ── Request / response types (discriminated union, named responses) ───────

export interface ResolveRequest {
  /** Absent kind means 'resolve' — v1 clients never send it (back-compat). */
  kind?: 'resolve';
  candidates: EntityCandidate[];
  priorContextText?: string;
  maxPointers?: number;
  /**
   * Optional source claim. On a server started with opts.boundSourceId, any
   * OTHER value is rejected with 'source_mismatch' [CX2-10] — same binding as
   * turn_context. Unbound (legacy positional) servers pass it through.
   */
  sourceId?: string;
  /** v0.43 (#2095, codex D7): suppression mode — 'slug-only' under windowing. */
  suppression?: 'slug-and-title' | 'slug-only';
}

export interface TurnContextRequest {
  kind: 'turn_context';
  /** Protocol version claim; the server echoes it so clients can detect a stale serve [A9]. */
  protocol: 2;
  /** Shared secret from `<dataDir>/.gbrain-ipc-secret` [S3#6]. resolve stays secret-free. */
  secret: string;
  /** Recent conversation turns, oldest → newest (trimmed oldest-first to fit the message cap [G11]). */
  window: WindowTurn[];
  priorContextText?: string;
  sessionId?: string;
  /** Optional source claim — the server REJECTS any value other than its bound source [CX2-10]. */
  sourceId?: string;
  maxBytes?: number;
  /**
   * Event-attribution channel for the delivery-point feedback loop (harness
   * hook adapters): the server logs the delivered block's volunteered pages /
   * pointers to context_volunteer_events under this channel so
   * `volunteer-context --stats` and the volunteer_channels doctor check see
   * per-harness firing. Validated server-side against the known channel set;
   * absent/unknown → 'claude-code' (the only harness bootstrap registers
   * hooks for today). Additive: old servers ignore it (no logging — the
   * pre-feedback-loop status quo).
   */
  channel?: string;
}

/**
 * v0.45.7 ambient recall — boundary context pack over IPC. Two modes:
 *   - assembly (default): the server resolves standing entities (request
 *     `entities` + window extraction + the session row's banked set), assembles
 *     a pack (cards + open threads + hot facts + since-delta vs the session
 *     cursor), advances the cursor, and returns the injectable block.
 *   - bankOnly: PreCompact banking — extract entities from `window`, merge
 *     them into the session row's standing set, return an empty block. The
 *     post-compaction SessionStart (source=compact) then serves a warm pack.
 * Same secret + source-binding posture as turn_context. World-only ALWAYS
 * (the push path never widens — include_private is a pull-verb affordance).
 */
export interface ContextPackRequest {
  kind: 'context_pack';
  protocol: 2;
  secret: string;
  sessionId?: string;
  sourceId?: string;
  /** Explicit standing entities (names/slugs); merged with the session row's banked set. */
  entities?: string[];
  /** Recent turns for entity extraction (compact banking / cold-start fallback). */
  window?: WindowTurn[];
  maxBytes?: number;
  /** Trigger discriminator ('session-start:<source>' | 'compact-bank').
   * RESERVED: carried on the wire for future server-side telemetry; no
   * server-side consumer yet (the hook-side heartbeat is the current
   * observability channel). */
  trigger?: string;
  /** PreCompact banking mode: persist entities, skip assembly. */
  bankOnly?: boolean;
}

export type IpcRequest = ResolveRequest | TurnContextRequest | ContextPackRequest;

export interface ResolveResponse {
  ok: boolean;
  block?: PointerBlock | null;
  error?: string;
}

export interface TurnContextResponse {
  ok: boolean;
  /** Always 2 on a v2 server. A response WITHOUT this echo is a stale (v1) serve [A9]. */
  protocol: 2;
  block?: TurnContextResult | null;
  degradedReason?: string;
  error?: string;
}

export interface ContextPackResponse {
  ok: boolean;
  /** Always 2 on a v2 server (stale-serve detector, same as turn_context [A9]). */
  protocol: 2;
  block?: TurnContextResult | null;
  degradedReason?: string;
  error?: string;
}

export type ResolveHandler = (req: ResolveRequest) => Promise<PointerBlock | null>;
export type TurnContextHandler = (req: TurnContextRequest) => Promise<TurnContextResult | null>;
export type ContextPackHandler = (req: ContextPackRequest) => Promise<TurnContextResult | null>;

/** Handler MAP replacing the single closure [ENG-3]. */
export interface IpcHandlers {
  resolve: ResolveHandler;
  turn_context?: TurnContextHandler;
  context_pack?: ContextPackHandler;
}

export interface IpcServerOpts {
  /**
   * v0.43 (#2095, red-team): fired ONLY after the resolve response was
   * successfully written to the client — the accept-side seam for
   * reflex-channel feedback logging. A block the client never received
   * (timeout, dead socket) was never injected into a prompt and must not
   * count as "volunteered".
   */
  onDelivered?: (block: PointerBlock, req: ResolveRequest) => void;
  /**
   * turn_context sibling of onDelivered — fired ONLY after an ok
   * turn_context response with a non-empty block was successfully written to
   * the client. This is the #2095 feedback-loop seam for the hook lane: the
   * callback logs the block's post-trim volunteered pages + pointers to
   * context_volunteer_events under req.channel. Same red-team rule as
   * onDelivered: a block the client's budget abandoned was never injected
   * and must not be counted.
   */
  onTurnContextDelivered?: (result: TurnContextResult, req: TurnContextRequest) => void;
  /**
   * The server's registered source [CX2-10]. turn_context requests naming a
   * DIFFERENT sourceId are rejected with 'source_mismatch'; the handler always
   * assembles against the bound source regardless.
   */
  boundSourceId?: string;
  /**
   * Shared secret value for turn_context [S3#6] (from ensureIpcSecret).
   * When a turn_context handler is registered without a secret, every
   * turn_context request is rejected 'unauthorized' (fail closed).
   */
  secret?: string;
}

/** Canonical socket path for a PGLite data dir. */
export function resolveSocketPath(dataDir: string): string {
  return join(dataDir, SOCK_NAME);
}

// ── Shared secret [S3#6] ──────────────────────────────────────────────────

/** Canonical shared-secret file path for a PGLite data dir. */
export function ipcSecretPath(dataDir: string): string {
  return join(dataDir, SECRET_NAME);
}

/**
 * Server-side: read the shared secret, creating a fresh 32-byte random hex
 * secret at `<dataDir>/.gbrain-ipc-secret` (mode 0600) if absent. Throws only
 * when the file can neither be read nor created (callers treat that as
 * "turn_context disabled", never as "skip auth").
 */
export function ensureIpcSecret(dataDir: string): string {
  const p = ipcSecretPath(dataDir);
  try {
    const existing = readFileSync(p, 'utf8').trim();
    if (existing) {
      try { chmodSync(p, 0o600); } catch { /* best effort */ }
      return existing;
    }
  } catch { /* absent or unreadable — create below */ }
  const secret = randomBytes(32).toString('hex');
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, secret + '\n', { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* best effort */ }
  return secret;
}

/** Client-side: read the shared secret; null when absent (no server has created it). */
export function readIpcSecret(dataDir: string): string | null {
  try {
    const s = readFileSync(ipcSecretPath(dataDir), 'utf8').trim();
    return s || null;
  } catch {
    return null;
  }
}

/** Constant-time secret comparison (length mismatch short-circuits — leaks length only). */
function secretMatches(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== 'string' || !candidate || !expected) return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── Clients ───────────────────────────────────────────────────────────────

/**
 * v1 client: ship candidates to a running serve, get pointers back. Returns
 * IPC_UNAVAILABLE when no server is listening (caller falls through the ladder);
 * a real PointerBlock | null otherwise. Never throws — fail-soft to UNAVAILABLE.
 */
export async function resolveViaIpc(
  socketPath: string,
  req: ResolveRequest,
): Promise<PointerBlock | null | typeof IPC_UNAVAILABLE> {
  const resp = await roundTrip(socketPath, JSON.stringify(req), CLIENT_TIMEOUT_MS);
  if (resp === IPC_UNAVAILABLE) return IPC_UNAVAILABLE;
  if (resp && (resp as ResolveResponse).ok) return (resp as ResolveResponse).block ?? null;
  return IPC_UNAVAILABLE;
}

/** Client-facing turn_context request shape (kind/protocol are filled in by the helper). */
export type TurnContextClientRequest = Omit<TurnContextRequest, 'kind' | 'protocol'>;

/**
 * Typed degraded marker for a v1 server answering a v2 request [A9] — the
 * response parsed but carried no protocol echo, so its (empty) block must
 * not be trusted as "nothing relevant".
 */
export interface TurnContextStaleServe {
  degraded: 'stale_serve';
}

export type TurnContextIpcResult =
  | TurnContextResponse
  | TurnContextStaleServe
  | typeof IPC_UNAVAILABLE;

/**
 * v2 client: request an assembled turn-context block from a running serve.
 * Mirrors resolveViaIpc's fail-soft style — socket/timeout/parse trouble is
 * IPC_UNAVAILABLE, a protocol-less response is { degraded: 'stale_serve' },
 * everything else is the server's typed TurnContextResponse (including
 * ok:false rejections like 'unauthorized' / 'source_mismatch', which callers
 * may want to surface). Never throws.
 *
 * [G11] The request is clamped below the 256KB message cap before send by
 * trimming window turns oldest-first.
 */
export async function requestTurnContext(
  socketPath: string,
  req: TurnContextClientRequest,
  opts: { timeoutMs?: number } = {},
): Promise<TurnContextIpcResult> {
  const full: TurnContextRequest = {
    kind: 'turn_context',
    protocol: 2,
    ...req,
    window: Array.isArray(req.window) ? [...req.window] : [],
  };
  let line = JSON.stringify(full);
  // Trim to the message cap [G11] in priority order: the ADVISORY dedupe
  // payload (priorContextText) is dropped BEFORE any essential window turn —
  // evicting the window first would silently hollow out candidate extraction
  // (empty blocks with ok:true) to preserve a hint. Then window turns,
  // oldest-first.
  if (Buffer.byteLength(line, 'utf8') + 1 > MAX_MSG_BYTES && full.priorContextText) {
    delete full.priorContextText;
    line = JSON.stringify(full);
  }
  while (Buffer.byteLength(line, 'utf8') + 1 > MAX_MSG_BYTES && full.window.length > 0) {
    full.window.shift();
    line = JSON.stringify(full);
  }
  if (Buffer.byteLength(line, 'utf8') + 1 > MAX_MSG_BYTES) return IPC_UNAVAILABLE;

  const resp = await roundTrip(socketPath, line, opts.timeoutMs ?? TURN_CONTEXT_CLIENT_TIMEOUT_MS);
  if (resp === IPC_UNAVAILABLE) return IPC_UNAVAILABLE;
  if (!resp || typeof resp !== 'object') return IPC_UNAVAILABLE;
  // Stale-serve detection [A9]: no protocol echo → a v1 server handled this
  // as a resolve request; its block is meaningless for turn_context.
  if ((resp as { protocol?: unknown }).protocol !== 2) return { degraded: 'stale_serve' };
  return resp as TurnContextResponse;
}

/** Client-facing context_pack request shape (kind/protocol filled in by the helper). */
export type ContextPackClientRequest = Omit<ContextPackRequest, 'kind' | 'protocol'>;

export type ContextPackIpcResult =
  | ContextPackResponse
  | TurnContextStaleServe
  | typeof IPC_UNAVAILABLE;

/**
 * v0.45.7 client: request a boundary context pack (or a PreCompact entity bank)
 * from a running serve. Same fail-soft ladder as requestTurnContext: transport
 * trouble → IPC_UNAVAILABLE; missing protocol echo → stale_serve; otherwise
 * the server's typed response. Never throws. Window trims oldest-first under
 * the message cap [G11].
 */
export async function requestContextPack(
  socketPath: string,
  req: ContextPackClientRequest,
  opts: { timeoutMs?: number } = {},
): Promise<ContextPackIpcResult> {
  const full: ContextPackRequest = {
    kind: 'context_pack',
    protocol: 2,
    ...req,
    ...(req.window ? { window: [...req.window] } : {}),
  };
  let line = JSON.stringify(full);
  while (
    Buffer.byteLength(line, 'utf8') + 1 > MAX_MSG_BYTES &&
    Array.isArray(full.window) &&
    full.window.length > 0
  ) {
    full.window.shift();
    line = JSON.stringify(full);
  }
  if (Buffer.byteLength(line, 'utf8') + 1 > MAX_MSG_BYTES) return IPC_UNAVAILABLE;

  const resp = await roundTrip(socketPath, line, opts.timeoutMs ?? CONTEXT_PACK_CLIENT_TIMEOUT_MS);
  if (resp === IPC_UNAVAILABLE) return IPC_UNAVAILABLE;
  if (!resp || typeof resp !== 'object') return IPC_UNAVAILABLE;
  if ((resp as { protocol?: unknown }).protocol !== 2) return { degraded: 'stale_serve' };
  return resp as ContextPackResponse;
}

/** One request line out, one response line back. Fail-soft to IPC_UNAVAILABLE. */
function roundTrip(
  socketPath: string,
  requestLine: string,
  timeoutMs: number,
): Promise<unknown | typeof IPC_UNAVAILABLE> {
  if (!existsSync(socketPath)) return Promise.resolve(IPC_UNAVAILABLE);
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    const finish = (v: unknown | typeof IPC_UNAVAILABLE) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* noop */ }
      resolve(v);
    };
    const sock = net.createConnection(socketPath);
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => {
      sock.write(requestLine + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_MSG_BYTES) return finish(IPC_UNAVAILABLE);
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        return finish(JSON.parse(buf.slice(0, nl)));
      } catch {
        return finish(IPC_UNAVAILABLE);
      }
    });
    // Any error (ENOENT, ECONNREFUSED, stale socket), timeout, or close before
    // a response → treat as unavailable, fall through the ladder.
    sock.on('timeout', () => finish(IPC_UNAVAILABLE));
    sock.on('error', () => finish(IPC_UNAVAILABLE));
    sock.on('close', () => finish(IPC_UNAVAILABLE));
  });
}

// ── Server ────────────────────────────────────────────────────────────────

/**
 * Server: start an IPC listener on `socketPath`. Cleans up a stale socket
 * left by a dead owner first, hardens the parent dir to 0700, and chmods the
 * socket 0600 BEFORE announcing readiness [S3#6]. Returns the net.Server
 * (caller closes on shutdown). Errors are swallowed (best-effort feature) —
 * returns null if the socket can't be bound.
 *
 * Two call shapes [ENG-3]:
 *   - legacy positional: (socketPath, resolveHandler, onDelivered?) — v1
 *     callers unchanged.
 *   - handler map: (socketPath, { resolve, turn_context? }, opts?) — v2.
 */
export async function startResolveIpcServer(
  socketPath: string,
  handler: ResolveHandler,
  onDelivered?: (block: PointerBlock, req: ResolveRequest) => void,
): Promise<net.Server | null>;
export async function startResolveIpcServer(
  socketPath: string,
  handlers: IpcHandlers,
  opts?: IpcServerOpts,
): Promise<net.Server | null>;
export async function startResolveIpcServer(
  socketPath: string,
  handlerOrHandlers: ResolveHandler | IpcHandlers,
  onDeliveredOrOpts?: ((block: PointerBlock, req: ResolveRequest) => void) | IpcServerOpts,
): Promise<net.Server | null> {
  const handlers: IpcHandlers =
    typeof handlerOrHandlers === 'function' ? { resolve: handlerOrHandlers } : handlerOrHandlers;
  const opts: IpcServerOpts =
    typeof onDeliveredOrOpts === 'function'
      ? { onDelivered: onDeliveredOrOpts }
      : onDeliveredOrOpts ?? {};

  // [S3#6] Parent dir 0700 (create if missing, tighten if present) so an
  // unrelated local user can't even see the socket / secret names.
  try {
    const dir = dirname(socketPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch { /* best effort */ }

  // Remove a stale socket file if present (a previous serve that didn't clean up).
  cleanupStaleSocket(socketPath);

  return new Promise((resolve) => {
    const server = net.createServer((conn) => {
      let buf = '';
      // One request per connection: once a line is being handled, later data
      // events are ignored. Without this, bytes arriving after the newline
      // while the async handler is mid-await would re-find the SAME first
      // line and process it concurrently — duplicate handler work, duplicate
      // response writes, and duplicated delivery-point event logging.
      let handled = false;
      conn.setEncoding('utf8');
      conn.on('data', async (chunk: string) => {
        if (handled) return;
        buf += chunk;
        if (buf.length > MAX_MSG_BYTES) { conn.destroy(); return; }
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        handled = true;
        const line = buf.slice(0, nl);
        let resp: string;
        let delivered: { block: PointerBlock; req: ResolveRequest } | null = null;
        let deliveredTurnContext: { result: TurnContextResult; req: TurnContextRequest } | null = null;
        try {
          const parsed = JSON.parse(line) as IpcRequest;
          const kind = (parsed as { kind?: unknown }).kind ?? 'resolve';
          if (kind === 'resolve') {
            const req = parsed as ResolveRequest;
            // [CX2-10] Same source binding as turn_context: a bound server
            // serves ITS registered source only — a resolve request naming a
            // different source is rejected, never re-routed. Unbound servers
            // (legacy positional callers) keep the v1 pass-through behavior.
            if (req.sourceId && opts.boundSourceId && req.sourceId !== opts.boundSourceId) {
              resp = JSON.stringify({ ok: false, error: 'source_mismatch' } satisfies ResolveResponse);
            } else {
              const block = await handlers.resolve(req);
              const out: ResolveResponse = { ok: true, block };
              resp = JSON.stringify(out);
              if (block) delivered = { block, req };
            }
          } else if (kind === 'turn_context') {
            const req = parsed as TurnContextRequest;
            const tcResp = await handleTurnContext(req, handlers, opts);
            resp = JSON.stringify(tcResp);
            // Feedback-loop seam: only an ok response carrying a non-empty
            // block counts as a candidate delivery (rejections, degraded-null
            // and empty blocks injected nothing).
            if (tcResp.ok && tcResp.block && tcResp.block.text) {
              deliveredTurnContext = { result: tcResp.block, req };
            }
          } else if (kind === 'context_pack') {
            resp = JSON.stringify(
              await handleContextPack(parsed as ContextPackRequest, handlers, opts),
            );
          } else {
            resp = JSON.stringify({ ok: false, error: `unknown_kind:${String(kind)}` });
          }
        } catch (e) {
          resp = JSON.stringify({ ok: false, error: (e as Error).message });
        }
        try {
          conn.write(resp + '\n');
          // Write accepted — the client (250ms budget) may still have hung
          // up, but this is the closest observable delivery point.
          if (delivered && opts.onDelivered) {
            try { opts.onDelivered(delivered.block, delivered.req); } catch { /* telemetry only */ }
          }
          if (deliveredTurnContext && opts.onTurnContextDelivered) {
            try { opts.onTurnContextDelivered(deliveredTurnContext.result, deliveredTurnContext.req); } catch { /* telemetry only */ }
          }
        } catch { /* client gone — do NOT log undelivered pointers */ }
        conn.end();
      });
      conn.on('error', () => { try { conn.destroy(); } catch { /* noop */ } });
    });
    server.on('error', () => resolve(null));
    server.listen(socketPath, () => {
      // Mode set BEFORE readiness is announced (the resolve() below) [S3#6].
      try { chmodSync(socketPath, 0o600); } catch { /* best effort */ }
      resolve(server);
    });
  });
}

/** turn_context server path: auth [S3#6] → source binding [CX2-10] → budgeted assembly [G11]. */
async function handleTurnContext(
  req: TurnContextRequest,
  handlers: IpcHandlers,
  opts: IpcServerOpts,
): Promise<TurnContextResponse> {
  if (!handlers.turn_context) {
    return { ok: false, protocol: 2, error: 'unsupported_kind' };
  }
  if (req.protocol !== 2) {
    return { ok: false, protocol: 2, error: 'unsupported_protocol' };
  }
  // Fail closed: no configured secret means NO turn_context service, not open service.
  if (!opts.secret || !secretMatches(req.secret, opts.secret)) {
    return { ok: false, protocol: 2, error: 'unauthorized' };
  }
  // [CX2-10] The server serves ITS registered source only. A request naming a
  // different source is an authorization error, not a routing hint.
  if (req.sourceId && opts.boundSourceId && req.sourceId !== opts.boundSourceId) {
    return { ok: false, protocol: 2, error: 'source_mismatch' };
  }
  try {
    const budget = new Promise<'__budget__'>((r) => {
      const t = setTimeout(() => r('__budget__'), TURN_CONTEXT_SERVER_BUDGET_MS);
      t.unref?.();
    });
    const result = await Promise.race([handlers.turn_context(req), budget]);
    if (result === '__budget__') {
      return { ok: true, protocol: 2, block: null, degradedReason: 'server_budget' };
    }
    return {
      ok: true,
      protocol: 2,
      block: result,
      ...(result?.degradedReason ? { degradedReason: result.degradedReason } : {}),
    };
  } catch (e) {
    return { ok: false, protocol: 2, error: (e as Error).message };
  }
}

/**
 * context_pack server path — same ladder as turn_context (auth [S3#6] →
 * source binding [CX2-10] → budgeted work), with a WIDER budget (cards) and
 * partial-pack semantics: the registered handler passes the budget into the
 * assembler as a wall-clock deadline, so the race below is only the backstop
 * for a hung handler, not the primary degrade mechanism (eng 4A).
 */
async function handleContextPack(
  req: ContextPackRequest,
  handlers: IpcHandlers,
  opts: IpcServerOpts,
): Promise<ContextPackResponse> {
  if (!handlers.context_pack) {
    return { ok: false, protocol: 2, error: 'unsupported_kind' };
  }
  if (req.protocol !== 2) {
    return { ok: false, protocol: 2, error: 'unsupported_protocol' };
  }
  if (!opts.secret || !secretMatches(req.secret, opts.secret)) {
    return { ok: false, protocol: 2, error: 'unauthorized' };
  }
  if (req.sourceId && opts.boundSourceId && req.sourceId !== opts.boundSourceId) {
    return { ok: false, protocol: 2, error: 'source_mismatch' };
  }
  try {
    const budget = new Promise<'__budget__'>((r) => {
      const t = setTimeout(() => r('__budget__'), CONTEXT_PACK_SERVER_BUDGET_MS + 200);
      t.unref?.();
    });
    const result = await Promise.race([handlers.context_pack(req), budget]);
    if (result === '__budget__') {
      return { ok: true, protocol: 2, block: null, degradedReason: 'server_budget' };
    }
    return {
      ok: true,
      protocol: 2,
      block: result,
      ...(result?.degradedReason ? { degradedReason: result.degradedReason } : {}),
    };
  } catch (e) {
    return { ok: false, protocol: 2, error: (e as Error).message };
  }
}

/** Remove a socket file whose owning process is gone (or any leftover file). */
export function cleanupStaleSocket(socketPath: string): void {
  try {
    if (existsSync(socketPath)) {
      // A unix socket shows up as a socket file; unlink unconditionally — if a
      // live server holds it, listen() below would fail and we return null.
      const st = statSync(socketPath);
      if (st.isSocket() || st.isFIFO() || st.isFile()) unlinkSync(socketPath);
    }
  } catch {
    /* best effort */
  }
}
