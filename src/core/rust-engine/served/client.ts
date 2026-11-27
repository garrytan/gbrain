/**
 * The client side of protocol v3 (docs/designs/rust-engine/multi-user-server.md, "M1 as built"; interface I-7). A
 * Rust engine configured with a brain server (`rust_server`) connects here instead of opening a store; the
 * connection is an `OwnerConnection`, so owner-ipc/client.ts `installOwnerClient` installs the same forwarded members a
 * local second process has, and their answers decode to the same values.
 *
 * - URLs: `gbrain+tls://host:port` (TLS; the server certificate is verified against `ca` or the system store before the
 *   token is sent), `gbrain+tcp://127.0.0.1:port` (plain TCP, loopback only), `gbrain+unix:///path` (an owner socket).
 * - Every call carries a request id (`req`, UUID v7) and the caller's remote mark. When the connection drops, the
 *   client reconnects and resends each call still waiting with the same `req` and `retry: true`; the server answers
 *   with the call's outcome, runs a read again, or ends a write it has no record of `outcome_unknown`
 *   (served/requests.ts). A call inside a transaction is never resent: the transaction rolled back with the connection.
 * - `owner_busy` (the call never ran) is retried with backoff within the caller's deadline (60 s when it has none), so
 *   a caller sees only `timeout` at its own deadline (decision R).
 * - A function argument crosses as a callback the server calls back (`cbcall`); a void notification key stays a
 *   notification. A transaction handle the server passes to a callback is a proxy whose calls run in that transaction.
 * - The newest commit position any write returned is kept (`lastPosition`) for a later read that needs it.
 */
import net, { type Socket } from 'node:net';
import tls from 'node:tls';
import { randomUUIDv7 } from 'bun';
import { requestSignal } from '../../request-signal.ts';
import { engineScopeStore } from '../../engine-scope-store.ts';
import { schemaVersionSeen } from '../../migrate-pending.ts';
import { readDeadline } from '../../read-deadline.ts';
import { currentStatementDeadline } from '../../statement-deadline.ts';
import { callerAccessRecord } from '../../search/private-visibility.ts';
import { decodeError, decodeValue, encodeError, encodeValue, OwnerIpcEncodeError, type Wire } from '../owner-ipc/codec.ts';
import {
  OWNER_IPC_VERSION_V3, SERVED_SERVER_CAPS, comparePositions, frameLine, readFrames, type CommitPositionWire, type OwnerHello,
} from '../owner-ipc/protocol.ts';
import { OWNER_IPC_CALLBACK_KEYS, OWNER_IPC_REMOTE_READS, OWNER_IPC_REMOTE_SIDE_WRITES, ownerCallCancelled, ownerCallTimeout, ownerIpcProtocol, ownerIpcRefusal } from '../owner-ipc/routes.ts';
import type { OwnerConnection } from '../owner-ipc/client.ts';
import { callerIsRemote } from '../owner-ipc/client.ts';
import { encodeLengthFrame, extractTail, readLengthFrames, restoreTail, byteBudget, SERVED_MAX_FRAME_BYTES } from './framing.ts';
import { servedGone, servedUnreachable } from './errors.ts';
import { opError } from '../../ops/contract.ts';
import { grouperTableOf } from '../owner-ipc/client.ts';
import { currentReadPosition } from './read-position.ts';
import { HELD_ROW_HOOK, HELD_ROW_TAG } from '../owner-ipc/held-row.ts';
import { remoteWholeOperationCall } from './remote-whole-ops.ts';

const DEFAULT_BUSY_BUDGET_MS = 60_000;
const DEFAULT_RECONNECT_MS = 10_000;
const CLIENT_DEADLINE_GRACE_MS = 2_000;

export interface ServedEndpoint { kind: 'tls' | 'tcp' | 'unix'; host?: string; port?: number; path?: string }

/** Parses a brain server URL; throws `config_error` for anything else (the URL never carries a credential). */
export function parseServedUrl(url: string): ServedEndpoint {
  const m = /^gbrain\+(tls|tcp|unix):\/\/(.+)$/.exec(url.trim());
  if (!m) throw servedConfigError(`The brain server URL is not gbrain+tls://host:port, gbrain+tcp://127.0.0.1:port or gbrain+unix:///path.`);
  if (m[1] === 'unix') return { kind: 'unix', path: m[2]!.startsWith('/') ? m[2]! : `/${m[2]}` };
  const hp = /^(\[[^\]]+\]|[^:/@]+):(\d{1,5})\/?$/.exec(m[2]!);
  if (!hp) throw servedConfigError('The brain server URL needs a host and a port, and no user name or password.');
  const host = hp[1]!.replace(/^\[|\]$/g, '');
  if (m[1] === 'tcp' && !/^(localhost|::1|127(\.\d{1,3}){3})$/i.test(host)) {
    throw servedConfigError('Plain TCP to a brain server is allowed only on a loopback address; use gbrain+tls:// for any other host.');
  }
  return { kind: m[1] as 'tls' | 'tcp', host, port: Number(hp[2]) };
}

function servedConfigError(message: string) {
  return opError('config_error', message, 'Set rust_server.url in the gbrain config (or GBRAIN_RUST_SERVER_URL) to the brain server address.');
}

export interface ConnectServedOptions {
  token?: string;
  /** PEM CA certificates that sign the server certificate (default: the system store). */
  ca?: string | Buffer;
  timeoutMs?: number;
  /** Capabilities to offer (default: all this build knows). */
  caps?: readonly string[];
  /** How long a lost connection is retried before its calls end `owner_unavailable` (default 10 s). */
  reconnectMs?: number;
}

export interface ServedConnection extends OwnerConnection {
  readonly hello: OwnerHello & { v: 3; caps: string[]; server_id: string };
  readonly caps: ReadonlySet<string>;
  /** True when the server is reached over the network (its paths are not this machine's). */
  readonly network: boolean;
  /** The newest commit position a write on this connection returned. */
  readonly lastPosition: CommitPositionWire | null;
  /** Sends one call or whole operation; `txn` binds it to an open transaction (served/transaction.ts). */
  request(kind: 'call' | 'fn', member: string, args: unknown[], opts?: { txn?: string }): Promise<unknown>;
  /** Sends a transaction frame and resolves with its value (a transaction id for `begin`). */
  txn(op: 'begin' | 'commit' | 'rollback', opts: { txn?: string; readOnly?: boolean; rerunOf?: string }): Promise<unknown>;
  /** Builds the engine-shaped proxy of a transaction the server holds (set by served/transaction.ts). */
  txProxy?: (ref: string) => unknown;
}

interface Pending {
  member: string;
  frame: Record<string, unknown>;
  tail: Buffer | null;
  callbacks: Map<string, (...args: unknown[]) => unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
  busyUntil: number;
  busyAttempts: number;
  txn?: string;
  /**
   * True once a copy of the frame was written and no answer since says it never ran (`owner_busy`): such a call may have
   * run, so a resend after a reconnect is a retry the server answers by its request id. False before the first write and
   * after a busy answer, so its resend is fresh (follow-up L3-F2).
   */
  mayHaveRun: boolean;
  /** Bumped by every write of the frame, so a stale busy backoff never sends a second copy. */
  attempt: number;
}

function callDeadline(): { deadlineAt?: number; readDeadlineAt?: number } {
  const read = readDeadline();
  const statement = currentStatementDeadline()?.deadlineAt ?? undefined;
  const candidates = [read, statement].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return {
    ...(candidates.length ? { deadlineAt: Math.min(...candidates) } : {}),
    ...(typeof read === 'number' ? { readDeadlineAt: read } : {}),
  };
}

function lastKey(path: string): string {
  const at = Math.max(path.lastIndexOf('.'), path.lastIndexOf('['));
  return at === -1 ? path : path.slice(at + 1).replace(/\]$/, '');
}

/**
 * The caller's engine scope, as a call carries it (session.ts runs the call in a scope on the server that answers the
 * same): set whenever the call runs in an engine scope, with the schema version that scope's engine recorded, which is
 * what privacy reads choose their form from (search/private-visibility.ts readSchemaVersion). Undefined outside one.
 */
function callerScope(): { sv: number | null } | undefined {
  const scoped = engineScopeStore.getStore();
  return scoped ? { sv: schemaVersionSeen(scoped) ?? null } : undefined;
}

/**
 * A call's arguments on the wire: signals collected, a void notification key kept as a notification, any other function
 * a callback the server calls back (with the `callbacks` capability), and a transaction handle a reference.
 */
function encodeCallArgs(args: unknown[], member: string, caps: ReadonlySet<string>, callbacks: Map<string, (...args: unknown[]) => unknown>,
  signals: Set<AbortSignal>): Wire {
  return encodeValue(args, {
    onSignal: signal => { signals.add(signal); return { $t: 'signal' }; },
    onFunction: (fn, path): Wire => {
      const table = grouperTableOf(fn);
      if (table) return { $t: 'fn', grouper: table };
      if (fn === HELD_ROW_HOOK) return HELD_ROW_TAG; // a job policy's decide hook stays here (owner-ipc/held-row.ts)
      const key = String(callbacks.size);
      callbacks.set(key, fn as (...a: unknown[]) => unknown);
      if (OWNER_IPC_CALLBACK_KEYS.has(lastKey(path))) return { $t: 'fn', k: key };
      if (!caps.has('callbacks')) throw ownerIpcRefusal(member, `its argument ${path.replace(/^value/, 'args')} is a function, and functions do not cross the owner socket`);
      return { $t: 'fn', k: key, r: 1 };
    },
    onObject: value => {
      const ref = (value as { __servedTxRef?: string }).__servedTxRef;
      return typeof ref === 'string' ? { $t: 'txref', id: ref } : undefined;
    },
  }, 'value');
}

/** Opens one transport to the endpoint and resolves once it is connected (TLS verified). */
export function openSocket(endpoint: ServedEndpoint, opts: ConnectServedOptions): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(servedUnreachable('server_unreachable', 'phase=connect timeout=true')); }, opts.timeoutMs ?? 5_000);
    let socket: Socket;
    const fail = (error: Error & { code?: string }) => {
      clearTimeout(timer);
      const untrusted = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT_ALTNAME_INVALID|HOSTNAME/i.test(`${error.code ?? ''} ${error.message}`);
      reject(servedUnreachable(untrusted ? 'tls_untrusted' : 'server_unreachable', `phase=connect error_code=${error.code ?? 'unknown'}`));
    };
    if (endpoint.kind === 'tls') {
      const tlsSocket = tls.connect({ host: endpoint.host, port: endpoint.port, servername: net.isIP(endpoint.host!) ? undefined : endpoint.host,
        ...(opts.ca ? { ca: opts.ca } : {}), rejectUnauthorized: true, minVersion: 'TLSv1.2' });
      socket = tlsSocket;
      tlsSocket.once('secureConnect', () => { clearTimeout(timer); resolve(tlsSocket); });
    } else {
      socket = endpoint.kind === 'unix' ? net.createConnection(endpoint.path!) : net.createConnection({ host: endpoint.host!, port: endpoint.port! });
      socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    }
    socket.once('error', fail);
  });
}

/**
 * Connects to a brain server and reads its v3 hello. Rejects with `owner_unavailable` (`server_unreachable`,
 * `tls_untrusted`), the server's `refused` error (`permission_denied` for a credential), or `owner_ipc_protocol`
 * (`version_mismatch`) for a server that speaks only v2.
 */
export async function connectServed(url: string, opts: ConnectServedOptions = {}): Promise<ServedConnection> {
  const endpoint = parseServedUrl(url);
  const network = endpoint.kind !== 'unix';
  const offered = [...(opts.caps ?? SERVED_SERVER_CAPS)];
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let socket: Socket;
  let hello!: ServedConnection['hello'];
  let caps = new Set<string>();
  let closedByUser = false;
  let lastPosition: CommitPositionWire | null = null;
  let reconnecting: Promise<void> | null = null;
  let write: (frame: object) => boolean = () => false;
  const txProxies = new Map<string, unknown>();

  const refresh = () => { if (pending.size) socket?.ref(); else socket?.unref(); };

  /** One transport and its hello; on success the session's frames route to `onFrame`. */
  const establish = async (): Promise<void> => {
    const s = await openSocket(endpoint, opts);
    const helloFrame = { t: 'hello', v: OWNER_IPC_VERSION_V3, version: OWNER_IPC_VERSION_V3, caps: offered,
      ...(opts.token ? { auth: { scheme: 'bearer', token: opts.token } } : {}) };
    await new Promise<void>((resolve, reject) => {
      let answered = false;
      const timer = setTimeout(() => { s.destroy(); reject(servedUnreachable('server_unreachable', 'phase=hello timeout=true')); }, opts.timeoutMs ?? 5_000);
      const onFirst = (frame: Record<string, unknown>, tail: Buffer | null) => {
        if (!answered) {
          answered = true;
          clearTimeout(timer);
          if (frame.t === 'refused') {
            let error: unknown;
            try { error = decodeError(frame.error as Wire); } catch { error = servedUnreachable('server_unreachable', 'phase=hello refused=undecodable'); }
            s.destroy();
            reject(error);
            return;
          }
          if (frame.t !== 'hello' || frame.version !== OWNER_IPC_VERSION_V3) {
            s.destroy();
            reject(ownerIpcProtocol('version_mismatch', null, `client_version=${OWNER_IPC_VERSION_V3} owner_version=${String(frame.version ?? 'none').slice(0, 16)}`));
            return;
          }
          hello = frame as unknown as ServedConnection['hello'];
          caps = new Set(Array.isArray(frame.caps) ? frame.caps.filter((c): c is string => typeof c === 'string') : []);
          socket = s;
          resolve();
          return;
        }
        onFrame(frame, tail);
      };
      if (network) {
        write = (frame) => {
          if (s.destroyed) return false;
          let wire = frame as unknown as Wire; let tail: Buffer | null = null;
          if (caps.has('binary_tail')) ({ value: wire, tail } = extractTail(wire));
          const buf = encodeLengthFrame(wire as object, tail);
          if (!buf) return false;
          s.write(buf);
          return true;
        };
        readLengthFrames(s, { maxFrameBytes: () => SERVED_MAX_FRAME_BYTES, budget: byteBudget(Number.MAX_SAFE_INTEGER), onFrame: (f, t) => onFirst(f, t), onBad: () => {} });
      } else {
        write = (frame) => { if (s.destroyed) return false; const line = frameLine(frame, SERVED_MAX_FRAME_BYTES); if (line === null) return false; s.write(line); return true; };
        readFrames(s, f => onFirst(f, null), () => {}, SERVED_MAX_FRAME_BYTES);
      }
      s.on('error', () => { /* close handles it */ });
      s.once('close', () => {
        clearTimeout(timer);
        if (!answered) { answered = true; reject(servedUnreachable('server_unreachable', 'phase=hello closed=true')); return; }
        if (socket === s) onLost();
      });
      write(helloFrame);
    });
    refresh();
  };

  /** Writes a pending call's frame once more; a call written may have run until an answer says otherwise. */
  const sendCall = (call: Pending): boolean => {
    call.frame.retry = call.mayHaveRun;
    call.attempt++;
    const written = write(call.frame);
    if (written) call.mayHaveRun = true;
    return written;
  };

  /**
   * Reconnects within the reconnect budget, then resends every waiting call: as a retry when it may have run (the server
   * answers it by its request id, never running a write twice), fresh when it never ran. When no connection comes back,
   * each call ends `owner_unavailable`, `outcome_unknown` if it may have run, else `not_sent`.
   */
  const reconnect = (): Promise<void> => (reconnecting ??= (async () => {
    const until = Date.now() + (opts.reconnectMs ?? DEFAULT_RECONNECT_MS);
    for (let wait = 50; ; wait = Math.min(1000, wait * 2)) {
      try { await establish(); lost = false; break; } catch (error) {
        if (Date.now() + wait >= until || (error as { code?: string }).code === 'permission_denied') { failAll(); return; }
        await new Promise(r => setTimeout(r, wait));
      }
    }
    for (const call of pending.values()) sendCall(call);
  })().finally(() => { reconnecting = null; }));

  /** Set when the connection dropped with no call waiting: the next call reconnects first. */
  let lost = false;

  const onLost = () => {
    if (closedByUser) { failAll(); return; }
    // Calls inside a transaction cannot be resent: their transaction rolled back with the connection.
    for (const [id, call] of pending) if (call.txn) { pending.delete(id); call.cleanup(); call.reject(servedGone(call.member, call.mayHaveRun)); }
    if (!pending.size) { lost = true; return; }
    void reconnect();
  };

  const failAll = () => {
    for (const call of pending.values()) { call.cleanup(); call.reject(servedGone(call.member, call.mayHaveRun)); }
    pending.clear();
  };

  const decodeOpts = () => ({ onTxRef: (wire: { [key: string]: Wire }) => {
    const ref = String(wire.id);
    let proxy = txProxies.get(ref);
    if (!proxy) { proxy = connection.txProxy?.(ref); txProxies.set(ref, proxy); }
    return proxy;
  } });

  const onCallback = (frame: Record<string, unknown>, tail: Buffer | null) => {
    const call = typeof frame.id === 'number' ? pending.get(frame.id) : undefined;
    const fn = call && typeof frame.key === 'string' ? call.callbacks.get(frame.key) : undefined;
    const cb = frame.cb;
    const answer = (ok: boolean, value: unknown) => {
      let wire: Wire;
      try { wire = ok ? encodeValue(value) : encodeError(value); } catch (error) { ok = false; wire = encodeError(error); }
      write(ok ? { t: 'cbresult', cb, ok: true, value: wire } : { t: 'cbresult', cb, ok: false, error: wire });
    };
    if (!fn) { answer(false, ownerIpcRefusal(String(frame.key ?? 'callback'), 'its callback is no longer waiting')); return; }
    void (async () => {
      try {
        const args = decodeValue(tail ? restoreTail(frame.args as Wire, tail) : frame.args as Wire, decodeOpts()) as unknown[];
        answer(true, await fn(...args));
      } catch (error) { answer(false, error); }
    })();
  };

  const onFrame = (frame: Record<string, unknown>, tail: Buffer | null) => {
    if (frame.t === 'cbcall') { onCallback(frame, tail); return; }
    const call = typeof frame.id === 'number' ? pending.get(frame.id) : undefined;
    if (!call) return;
    if (frame.t === 'cb') {
      const fn = typeof frame.key === 'string' ? call.callbacks.get(frame.key) : undefined;
      try { if (fn) void fn(...(decodeValue(frame.args as Wire) as unknown[])); } catch { /* a notification never fails the call */ }
      return;
    }
    if (frame.t !== 'result') return;
    let decoded: unknown;
    try {
      const raw = (frame.ok === true ? frame.value : frame.error) as Wire;
      const restored = tail ? restoreTail(raw, tail) : raw;
      decoded = frame.ok === true ? decodeValue(restored, decodeOpts()) : decodeError(restored);
    } catch (error) {
      pending.delete(frame.id as number); call.cleanup(); refresh();
      call.reject(ownerIpcProtocol('result_undecodable', call.member, `id=${String(frame.id)} ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    // owner_busy: the call never ran; send it again (not as a retry: the server forgot it) within the caller's budget.
    const code = (decoded as { code?: unknown } | null)?.code;
    if (frame.ok !== true && code === 'owner_busy' && Date.now() < call.busyUntil) {
      // The server says this copy never ran: until the next write, a resend after a drop is fresh.
      call.mayHaveRun = false;
      const delay = Math.min(1000, 25 * 2 ** Math.min(6, call.busyAttempts++));
      const attempt = call.attempt;
      setTimeout(() => {
        if (pending.get(frame.id as number) !== call || call.attempt !== attempt || reconnecting || lost) return;
        sendCall(call);
      }, delay).unref?.();
      return;
    }
    pending.delete(frame.id as number);
    call.cleanup();
    refresh();
    // A busy owner past the caller's budget: the call never ran, and the caller sees its own deadline (decision R).
    if (frame.ok !== true && code === 'owner_busy') {
      call.reject(ownerCallTimeout(call.member, Date.now() - Number(call.frame.sent_at ?? Date.now()), 'queued'));
      return;
    }
    const position = frame.position as CommitPositionWire | undefined;
    if (position && typeof position.sequence === 'number' && typeof position.index === 'number'
      && (!lastPosition || comparePositions(position, lastPosition) > 0)) lastPosition = { sequence: position.sequence, index: position.index };
    if (frame.ok === true) call.resolve(decoded); else call.reject(decoded);
  };

  const send = (frame: Record<string, unknown>, member: string, callbacks: Map<string, (...args: unknown[]) => unknown>, txn: string | undefined,
    signals: Set<AbortSignal>, deadlineAt: number | undefined): Promise<unknown> => {
    const id = frame.id as number;
    const startedAt = Date.now();
    return new Promise((resolveCall, rejectCall) => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      const listeners: Array<[AbortSignal, () => void]> = [];
      const cleanup = () => { if (grace) clearTimeout(grace); for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener); };
      const endLocally = (error: unknown) => {
        if (!pending.delete(id)) return;
        cleanup(); refresh();
        write({ t: 'cancel', id });
        rejectCall(error);
      };
      for (const signal of signals) {
        const listener = () => {
          const reason = signal.reason as { name?: unknown } | undefined;
          endLocally(reason?.name === 'TimeoutError' ? ownerCallTimeout(member, Date.now() - startedAt, 'sent') : ownerCallCancelled(member, true));
        };
        signal.addEventListener('abort', listener, { once: true });
        listeners.push([signal, listener]);
      }
      if (deadlineAt !== undefined) {
        const ms = Math.max(0, deadlineAt - Date.now());
        grace = setTimeout(() => endLocally(ownerCallTimeout(member, ms, 'sent')), Math.min(2 ** 31 - 1, ms + CLIENT_DEADLINE_GRACE_MS));
      }
      Object.defineProperty(frame, 'sent_at', { value: startedAt, enumerable: false });
      const call: Pending = { member, frame, tail: null, callbacks, resolve: resolveCall, reject: rejectCall, cleanup, txn,
        busyUntil: deadlineAt ?? Date.now() + DEFAULT_BUSY_BUDGET_MS, busyAttempts: 0, mayHaveRun: false, attempt: 0 };
      pending.set(id, call);
      refresh();
      // A connection that dropped (idle, or while this call was being made) reconnects first; the reconnect sends it.
      if (reconnecting || lost || socket.destroyed) {
        if (txn) { pending.delete(id); cleanup(); refresh(); rejectCall(servedGone(member, false)); return; }
        void reconnect();
        return;
      }
      if (!sendCall(call)) {
        pending.delete(id); cleanup(); refresh();
        rejectCall(socket.destroyed ? servedGone(member, false)
          : ownerIpcRefusal(member, `its arguments are larger than ${SERVED_MAX_FRAME_BYTES} bytes, the most the connection carries`));
      }
    });
  };

  const request = (kind: 'call' | 'fn', member: string, args: unknown[], ropts: { txn?: string } = {}): Promise<unknown> => {
    const remote = callerIsRemote();
    // The same refusal a local second process gives, before anything is sent; the server checks again on its side.
    if (remote && !remoteWholeOperationCall(kind, member, args) && !(kind === 'call' && OWNER_IPC_REMOTE_SIDE_WRITES.has(member)) && (kind === 'fn' || !OWNER_IPC_REMOTE_READS.has(member)) && !ropts.txn) {
      return Promise.reject(ownerIpcRefusal(member, kind === 'fn' ? 'a remote caller\'s whole operation is not sent to the brain owner' : 'a remote caller\'s write is not sent to the brain owner'));
    }
    if (closedByUser) return Promise.reject(servedGone(member, false));
    const id = nextId++;
    const callbacks = new Map<string, (...args: unknown[]) => unknown>();
    const signals = new Set<AbortSignal>();
    const ambient = requestSignal();
    if (ambient) signals.add(ambient);
    let wireArgs: Wire;
    try {
      wireArgs = encodeCallArgs(args, member, caps, callbacks, signals);
    } catch (error) {
      if (error instanceof OwnerIpcEncodeError) return Promise.reject(ownerIpcRefusal(member, error.message.replace(/\.$/, '')));
      return Promise.reject(error);
    }
    for (const signal of signals) if (signal.aborted) return Promise.reject(ownerCallCancelled(member, false));
    const { deadlineAt, readDeadlineAt } = callDeadline();
    const record = callerAccessRecord();
    const scope = callerScope();
    // Read-your-writes (I-2): a token the caller holds (read-position.ts) goes with the call; only a server with positions reads it.
    const minPosition = caps.has('positions') ? currentReadPosition() : undefined;
    const frame: Record<string, unknown> = {
      t: kind, id, [kind === 'fn' ? 'name' : 'member']: member, args: wireArgs, req: randomUUIDv7(), remote,
      ...(ropts.txn ? { txn: ropts.txn } : {}),
      ...(deadlineAt !== undefined ? { deadline_at: deadlineAt } : {}),
      ...(readDeadlineAt !== undefined ? { read_deadline_at: readDeadlineAt } : {}),
      ...(record ? { access: encodeValue(record) } : {}),
      ...(scope ? { scope } : {}),
      ...(minPosition ? { min_position: minPosition } : {}),
    };
    return send(frame, member, callbacks, ropts.txn, signals, deadlineAt);
  };

  const txn = (op: 'begin' | 'commit' | 'rollback', topts: { txn?: string; readOnly?: boolean; rerunOf?: string }): Promise<unknown> => {
    if (closedByUser) return Promise.reject(servedGone('transaction', false));
    const id = nextId++;
    const frame = { t: 'txn', id, op, ...(topts.txn ? { txn: topts.txn } : {}), ...(topts.readOnly ? { read_only: true } : {}),
      ...(topts.rerunOf ? { rerun_of: topts.rerunOf } : {}) };
    return send(frame, 'transaction', new Map(), topts.txn ?? (op === 'begin' ? 'begin' : undefined), new Set(), undefined);
  };

  await establish();
  const connection: ServedConnection = {
    get hello() { return hello; },
    get caps() { return caps; },
    get closed() { return closedByUser; },
    get lastPosition() { return lastPosition; },
    network,
    request,
    txn,
    pending: () => pending.size,
    close: () => { closedByUser = true; socket?.destroy(); },
  };
  return connection;
}
