/**
 * The client side of the Rust engine owner socket. A process that opens a Rust brain another process owns connects
 * here (election.ts) and its engine sends every forwarded BrainEngine member to the owner (routes.ts). One persistent
 * connection carries all of the process's calls at once.
 *
 * - A call carries the caller's deadline (the read deadline and the statement deadline of its async context) as
 *   `deadline_at`; the owner ends it there with `timeout`, queued (`not_started`) or running (`outcome_unknown`: a
 *   running write is not interrupted). The client keeps a short grace timer of its own in case the owner is stuck.
 * - The caller's AbortSignals (the request signal of request-signal.ts and any signal argument) end the call at once
 *   with `cancelled`, or `timeout` when the signal's reason is a TimeoutError, and tell the owner to stop it.
 * - When the owner goes away, every call in flight ends with `owner_unavailable` (`outcome_unknown`) and every later
 *   call with `owner_unavailable` (`not_sent`). There is no owner handoff in this release.
 * - The socket holds the event loop open only while a call is in flight, so a finished CLI command exits.
 */
import net, { type Socket } from 'node:net';
import { engineKey } from '../../engine-key.ts';
import { requestSignal } from '../../request-signal.ts';
import { readDeadline } from '../../read-deadline.ts';
import { currentStatementDeadline } from '../../statement-deadline.ts';
import { callerAccessRecord } from '../../search/private-visibility.ts';
import { prepareLocalIpcPath } from '../../context/ipc-path.ts';
import type { Capability } from '../../engine-capabilities.ts';
import { capabilityMissing } from '../errors.ts';
import { RUST_ENGINE_MEMBERS } from '../members.ts';
import { STORE_MEMBERS } from '../store-members/index.ts';
import { decodeError, decodeValue, encodeValue, OwnerIpcEncodeError, type Wire } from './codec.ts';
import {
  OWNER_IPC_MAX_FRAME_BYTES, OWNER_IPC_VERSION, frameLine, ownerSocketPath, readFrames, type OwnerHello,
} from './protocol.ts';
import {
  OWNER_IPC_CALLBACK_KEYS, OWNER_IPC_ROUTES, ownerCallCancelled, ownerCallTimeout, ownerGone, ownerIpcRefusal,
} from './routes.ts';

/** How long past `deadline_at` the client waits for the owner's own timeout before it ends the call itself. */
const CLIENT_DEADLINE_GRACE_MS = 2_000;

export interface OwnerConnection {
  readonly hello: OwnerHello;
  readonly closed: boolean;
  /** Sends one member call (`call`) or one whole operation (`fn`) and resolves with the owner's result. */
  request(kind: 'call' | 'fn', member: string, args: unknown[]): Promise<unknown>;
  /** Number of calls waiting for the owner; tests read it to prove nothing is left behind. */
  pending(): number;
  close(): void;
}

interface Pending {
  member: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  callbacks: Map<string, (...args: unknown[]) => void>;
  cleanup(): void;
}

const connections = new WeakMap<object, OwnerConnection>();
/** countPagesBy grouper functions the client resolved to a fixed table; they cross the socket as that table. */
const grouperTables = new WeakMap<object, { types: string[]; groups: string[] }>();

/** The owner connection an engine reaches its brain through, or undefined when the engine owns it (or is no client). */
export function ownerConnectionFor(engine: object): OwnerConnection | undefined {
  return connections.get(engineKey(engine));
}

function lastKey(path: string): string {
  const at = Math.max(path.lastIndexOf('.'), path.lastIndexOf('['));
  return at === -1 ? path : path.slice(at + 1).replace(/\]$/, '');
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

function abortError(member: string, signal: AbortSignal, startedAt: number, sent: boolean): Error {
  const reason = signal.reason as { name?: unknown } | undefined;
  return reason?.name === 'TimeoutError'
    ? ownerCallTimeout(member, Date.now() - startedAt, sent ? 'sent' : 'not_sent')
    : ownerCallCancelled(member, sent);
}

/** Connects to the owner socket and reads its hello. Rejects with the socket error (ENOENT, ECONNREFUSED) or a timeout. */
export function connectOwner(legacySocketPath: string, opts: { timeoutMs?: number } = {}): Promise<OwnerConnection> {
  const socketPath = prepareLocalIpcPath(legacySocketPath, false, true);
  const timeoutMs = opts.timeoutMs ?? 2_000;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let hello: OwnerHello | undefined;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('The brain owner did not answer its hello.'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    socket.once('error', error => { clearTimeout(timer); if (!hello) reject(error); });
    socket.once('connect', () => { socket.write(frameLine({ t: 'hello', version: OWNER_IPC_VERSION })!); });
    const pending = new Map<number, Pending>();
    let closed = false;
    let nextId = 1;
    const refresh = () => { if (pending.size) socket.ref(); else socket.unref(); };
    const send = (frame: object) => { if (!socket.destroyed) socket.write(frameLine(frame, Number.MAX_SAFE_INTEGER)!); };
    readFrames(socket, frame => {
      if (frame.t === 'hello') {
        if (hello) return;
        hello = frame as unknown as OwnerHello;
        clearTimeout(timer);
        socket.on('error', () => { /* close ends the calls */ });
        resolve(connection);
        refresh();
        return;
      }
      const call = pending.get(Number(frame.id));
      if (!call) return;
      if (frame.t === 'cb') {
        const fn = call.callbacks.get(String(frame.key));
        try { if (fn) fn(...(decodeValue(frame.args as Wire) as unknown[])); } catch { /* a notification never fails the call */ }
        return;
      }
      if (frame.t !== 'result') return;
      pending.delete(Number(frame.id));
      call.cleanup();
      refresh();
      if (frame.ok === true) call.resolve(decodeValue(frame.value as Wire));
      else call.reject(decodeError(frame.error as Wire));
    }, () => {}, OWNER_IPC_MAX_FRAME_BYTES);
    socket.once('close', () => {
      clearTimeout(timer);
      closed = true;
      if (!hello) { reject(Object.assign(new Error('The brain owner closed the connection before its hello.'), { code: 'ECONNRESET' })); return; }
      for (const call of pending.values()) { call.cleanup(); call.reject(ownerGone(call.member, hello.pid, true)); }
      pending.clear();
    });

    const request = (kind: 'call' | 'fn', member: string, args: unknown[]): Promise<unknown> => {
      if (closed || !hello) return Promise.reject(ownerGone(member, hello?.pid ?? null, false));
      const id = nextId++;
      const startedAt = Date.now();
      const callbacks = new Map<string, (...args: unknown[]) => void>();
      const signals = new Set<AbortSignal>();
      const ambient = requestSignal();
      if (ambient) signals.add(ambient);
      let wireArgs: Wire;
      try {
        wireArgs = encodeValue(args, {
          onSignal: signal => { signals.add(signal); return { $t: 'signal' }; },
          onFunction: (fn, path): Wire => {
            const table = grouperTables.get(fn);
            if (table) return { $t: 'fn', grouper: table };
            const key = lastKey(path);
            if (!OWNER_IPC_CALLBACK_KEYS.has(key)) throw ownerIpcRefusal(member, `its argument ${path.replace(/^value/, 'args')} is a function, and functions do not cross the owner socket`);
            const k = String(callbacks.size);
            callbacks.set(k, fn as (...a: unknown[]) => void);
            return { $t: 'fn', k };
          },
        }, 'value');
      } catch (error) {
        if (error instanceof OwnerIpcEncodeError) return Promise.reject(ownerIpcRefusal(member, error.message.replace(/\.$/, '')));
        return Promise.reject(error);
      }
      for (const signal of signals) {
        if (signal.aborted) return Promise.reject(abortError(member, signal, startedAt, false));
      }
      const { deadlineAt, readDeadlineAt } = callDeadline();
      // The caller's access record (who it is, what it may read) goes with the call, so the owner reads as this caller.
      const record = callerAccessRecord();
      const access = record ? encodeValue(record) : undefined;
      const line = frameLine({ t: kind, id, [kind === 'fn' ? 'name' : 'member']: member, args: wireArgs,
        ...(deadlineAt !== undefined ? { deadline_at: deadlineAt } : {}),
        ...(readDeadlineAt !== undefined ? { read_deadline_at: readDeadlineAt } : {}),
        ...(access ? { access } : {}) });
      if (line === null) return Promise.reject(ownerIpcRefusal(member, `its arguments are larger than ${OWNER_IPC_MAX_FRAME_BYTES} bytes, the most the owner socket carries`));
      return new Promise((resolveCall, rejectCall) => {
        let grace: ReturnType<typeof setTimeout> | undefined;
        const listeners: Array<[AbortSignal, () => void]> = [];
        const cleanup = () => {
          if (grace) clearTimeout(grace);
          for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
        };
        const endLocally = (error: unknown) => {
          if (!pending.delete(id)) return;
          cleanup();
          refresh();
          send({ t: 'cancel', id });
          rejectCall(error);
        };
        for (const signal of signals) {
          const listener = () => endLocally(abortError(member, signal, startedAt, true));
          signal.addEventListener('abort', listener, { once: true });
          listeners.push([signal, listener]);
        }
        if (deadlineAt !== undefined) {
          const ms = Math.max(0, deadlineAt - Date.now());
          grace = setTimeout(() => endLocally(ownerCallTimeout(member, ms, 'sent')), ms + CLIENT_DEADLINE_GRACE_MS);
        }
        pending.set(id, { member, resolve: resolveCall, reject: rejectCall, callbacks, cleanup });
        refresh();
        socket.write(line);
      });
    };

    const connection: OwnerConnection = {
      get hello() { return hello!; },
      get closed() { return closed; },
      request,
      pending: () => pending.size,
      close: () => { socket.destroy(); },
    };
  });
}

/**
 * Who owns a Rust brain, read from its owner socket's hello (the shape of pglite-lock.ts `inspectLockHolder`): held
 * with the owner's pid and whether it is a `gbrain serve`, or not held when nothing answers.
 */
export async function inspectRustOwner(databasePath: string, timeoutMs = 1_000): Promise<{
  held: boolean; pid?: number; serve?: boolean; subcommand?: string; kind?: string; capabilities?: string[];
}> {
  let connection: OwnerConnection;
  try { connection = await connectOwner(ownerSocketPath(databasePath), { timeoutMs }); }
  catch { return { held: false }; }
  const { pid, serve, kind, capabilities } = connection.hello;
  connection.close();
  return { held: true, pid, serve: serve === true, kind, capabilities: [...capabilities], ...(serve ? { subcommand: 'serve' } : {}) };
}

/**
 * True when a Rust brain's owner can serve the persistence socket: its engine reports `persistence_journal`. The
 * persistence provider runs SQL (persistence/context.ts, writer-versions.ts), so a Rust engine without that capability
 * would fail every call there; until it reports it, no persistence listener starts and callers use the engine path.
 */
export function rustOwnerServesPersistence(capabilities: Iterable<string> | undefined): boolean {
  return [...(capabilities ?? [])].includes('persistence_journal');
}

/**
 * The capability a member needs on a Rust owner that does not report it, or null when the call may be sent. Such a
 * member is refused here with the error the Rust engine gives in process (rust-engine.ts), so the client never asks
 * an owner for what it said it cannot do (executeRaw with no `raw_sql`). A member the Rust store serves
 * (store-members/index.ts) is always sent, because the owner runs it even when the rest of its capability class still
 * refuses. An owner of another kind (tests host PGLite) is asked as before.
 */
function missingOnRustOwner(hello: { kind: string; capabilities: readonly string[] }, member: string): Capability | null {
  if (hello.kind !== 'rust') return null;
  if (member in STORE_MEMBERS) return null;
  const cls = (RUST_ENGINE_MEMBERS as Record<string, string>)[member];
  if (cls === undefined || cls === 'implemented') return null;
  return hello.capabilities.includes(cls) ? null : cls as Capability;
}

type EngineRecord = Record<string, unknown>;

/**
 * countPagesBy takes a synchronous grouper over the brain's page types. The client asks the owner for the per-type
 * counts, runs the grouper here, and sends its answer as a fixed table. A type created between the two calls maps to
 * itself (the same as a type the grouper leaves unchanged).
 */
async function countPagesByThroughOwner(connection: OwnerConnection, args: unknown[]): Promise<unknown> {
  const [query, grouper] = args;
  if (typeof grouper !== 'function') return connection.request('call', 'countPagesBy', args);
  const first = await connection.request('call', 'countPagesBy', [query]) as { bySourceType?: Array<{ type: string }> };
  const types = [...new Set((first.bySourceType ?? []).map(row => row.type))];
  const groups = (grouper as (types: string[]) => string[])(types);
  const table = (input: string[]) => input.map(type => { const at = types.indexOf(type); return at === -1 ? type : groups[at]!; });
  grouperTables.set(table, { types, groups: [...groups] });
  return connection.request('call', 'countPagesBy', [query, table]);
}

/**
 * Makes `engine` a client of the owner on `connection`: each forwarded member becomes an own property that sends the
 * call, each refused member rejects with `engine_capability_missing`, and the engine's capability set mirrors the
 * owner's. Returns the function that undoes it (on disconnect or when the owner goes away).
 */
export function installOwnerClient(engine: object, connection: OwnerConnection): () => void {
  const record = engine as EngineRecord;
  const installed: string[] = [];
  for (const [member, route] of Object.entries(OWNER_IPC_ROUTES)) {
    if (route === 'local') continue;
    const missing = missingOnRustOwner(connection.hello, member);
    const value = missing !== null
      ? () => Promise.reject(capabilityMissing(missing, member))
      : route === 'refuse'
      ? () => Promise.reject(ownerIpcRefusal(member, 'transactions, reserved connections and engine callbacks do not cross the owner socket'))
      : member === 'countPagesBy'
        ? (...args: unknown[]) => countPagesByThroughOwner(connection, args)
        : (...args: unknown[]) => connection.request('call', member, args);
    Object.defineProperty(record, member, { value, writable: true, configurable: true, enumerable: false });
    installed.push(member);
  }
  const capabilities = record.capabilities as Set<string> | undefined;
  if (capabilities instanceof Set) { capabilities.clear(); for (const c of connection.hello.capabilities) capabilities.add(c); }
  const key = engineKey(engine);
  connections.set(key, connection);
  return () => {
    for (const member of installed) delete record[member];
    if (capabilities instanceof Set) capabilities.clear();
    if (connections.get(key) === connection) connections.delete(key);
    connection.close();
  };
}
