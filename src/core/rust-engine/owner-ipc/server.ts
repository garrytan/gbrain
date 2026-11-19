/**
 * The owner side of the Rust engine owner socket (docs/designs/RUST_ENGINE.md, "Owner protocol for the Rust engine").
 * The process that holds a brain's owner lock serves its engine here, and every other process on that brain sends its
 * BrainEngine calls through it (client.ts). The server takes any BrainEngine, so tests can host a PGLite engine as the
 * owner while the Rust store is still being built.
 *
 * - Calls run on a permit pool (OWNER_IPC_DEFAULT_PERMITS). A call over the limit waits in its connection's queue,
 *   and a free permit goes to the connections in turn (round-robin, FIFO inside one connection), so one client that
 *   floods the owner does not starve another. At its `deadline_at` a call ends with `timeout` (queued or running), and
 *   a `cancel` frame ends it with nothing more sent.
 * - Every call runs under its own AbortController: the request signal of the call (request-signal.ts), any
 *   AbortSignal argument the client sent, and the read deadline of the caller are restored in the owner.
 * - A permit is released only when the engine call itself settles, never when its reply is sent early (a timeout or
 *   a cancel), so the pool never runs more work than its size. `stats()` shows the pool for leak checks.
 * - A connection that closes aborts every call it started. Calls from other connections keep running.
 * - A request already past its `deadline_at` never starts, on arrival or when it leaves the queue.
 * - `close()` aborts every call and resolves only after all engine work that started has settled, so the owner lock
 *   (released by RustEngine.disconnect after close) never frees while the old owner still runs a call.
 */
import net, { type Server, type Socket } from 'node:net';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import type { BrainEngine } from '../../engine.ts';
import { withRequestSignal } from '../../request-signal.ts';
import { withReadDeadline } from '../../read-deadline.ts';
import { claimLocalIpcBinding, isWindowsIpcPipe } from '../../context/ipc-path.ts';
import { decodeValue, encodeError, encodeValue, type Wire } from './codec.ts';
import {
  OWNER_IPC_DEFAULT_PERMITS, OWNER_IPC_MAX_FRAME_BYTES, OWNER_IPC_VERSION, frameLine, readFrames, type OwnerHello,
} from './protocol.ts';
import { OWNER_IPC_ROUTES, ownerCallTimeout, ownerIpcRefusal, ownerResponseTooLarge } from './routes.ts';

/** A whole operation the owner runs for a client in one request (whole-op.ts); it may open its own transaction. */
export type OwnerWholeOperation = (engine: BrainEngine, ...args: unknown[]) => Promise<unknown>;

export interface OwnerServerOptions {
  permits?: number;
  /** True when this process is a `gbrain serve`; clients then use its persistence socket for MCP operations. */
  serve?: boolean;
  /** Whole operations clients may forward, by name. */
  wholeOperations?: Readonly<Record<string, OwnerWholeOperation>>;
  /** The frame cap; tests lower it to reach `response_too_large`. */
  maxFrameBytes?: number;
}

export interface OwnerServerStats { active: number; queued: number; connections: number }

export interface OwnerEngineServer {
  socketPath: string;
  stats(): OwnerServerStats;
  close(): Promise<void>;
}

interface PendingCall {
  id: number;
  member: string;
  run: () => Promise<unknown>;
  controller: AbortController;
  done: boolean;
  queued: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** Epoch ms after which the call must not start; a call past it ends with `timeout` and never runs. */
  deadlineAt?: number;
  reply(frame: object): void;
}

function timeoutReason(): Error {
  return new DOMException('The call reached its deadline on the brain owner.', 'TimeoutError');
}

/** Rebuilds a client function tag: a void callback that notifies the client, or a countPagesBy grouper. */
function rebuildFunction(wire: { [key: string]: Wire }, call: PendingCall, send: (frame: object) => void): unknown {
  if (wire.grouper && typeof wire.grouper === 'object' && !Array.isArray(wire.grouper)) {
    const types = (wire.grouper.types as string[] | undefined) ?? [];
    const groups = (wire.grouper.groups as string[] | undefined) ?? [];
    return (input: string[]) => input.map(type => { const at = types.indexOf(type); return at === -1 ? type : groups[at]; });
  }
  const key = typeof wire.k === 'string' ? wire.k : '';
  return (...args: unknown[]) => {
    if (call.done) return;
    try { send({ t: 'cb', id: call.id, key, args: encodeValue(args) }); } catch { /* a notification never fails the call */ }
  };
}

export async function serveOwnerEngine(
  engine: BrainEngine,
  legacySocketPath: string,
  opts: OwnerServerOptions = {},
): Promise<OwnerEngineServer | null> {
  const binding = await claimLocalIpcBinding(legacySocketPath);
  if (!binding) return null;
  const socketPath = binding.socketPath;
  try {
    // The owner lock is held, so a socket left here belongs to an owner that died. Never remove a non-socket.
    if (binding.removeStaleWindowsSocket) binding.removeStaleWindowsSocket();
    else if (!isWindowsIpcPipe(socketPath)) {
      if (!lstatSync(socketPath).isSocket()) throw new Error('The owner socket path is not a socket.');
      unlinkSync(socketPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await binding.release(); throw error; }
  }

  const permits = Math.max(1, opts.permits ?? OWNER_IPC_DEFAULT_PERMITS);
  const maxFrameBytes = opts.maxFrameBytes ?? OWNER_IPC_MAX_FRAME_BYTES;
  const wholeOperations = opts.wholeOperations ?? {};
  // One FIFO lane per connection, in turn order: the next permit goes to the first lane, which then moves to the end.
  const lanes = new Map<object, PendingCall[]>();
  const nextQueued = (): PendingCall | undefined => {
    for (const [lane, calls] of lanes) {
      lanes.delete(lane);
      const call = calls.shift();
      if (calls.length) lanes.set(lane, calls);
      if (call) return call;
    }
    return undefined;
  };
  const sockets = new Set<Socket>();
  let active = 0;
  let closing = false;
  let closed: Promise<void> | undefined;
  // Engine work that has started and not settled. close() waits for all of it before the owner lock can be released.
  const running = new Set<Promise<unknown>>();

  const expire = (call: PendingCall, queued: boolean) => {
    if (call.timer) clearTimeout(call.timer);
    call.reply({ t: 'result', id: call.id, ok: false, error: encodeError(ownerCallTimeout(call.member, 0, queued)) });
    call.controller.abort(timeoutReason());
  };

  const pump = () => {
    while (active < permits) {
      const call = nextQueued();
      if (!call) return;
      if (call.done) continue;
      if (closing) { call.done = true; call.controller.abort(new DOMException('The brain owner is closing.', 'AbortError')); continue; }
      // A timer fires on a later turn, so a call whose deadline passed while it waited is checked here, before it runs.
      if (call.deadlineAt !== undefined && Date.now() >= call.deadlineAt) { expire(call, true); continue; }
      call.queued = false;
      active++;
      let settled: Promise<unknown>;
      try { settled = call.run(); } catch (error) { settled = Promise.reject(error); }
      const tracked = settled.then(
        value => {
          if (call.done) return;
          let encoded: Wire;
          try { encoded = encodeValue(value); }
          catch (error) { call.reply({ t: 'result', id: call.id, ok: false, error: encodeError(error) }); return; }
          call.reply({ t: 'result', id: call.id, ok: true, value: encoded });
        },
        error => {
          if (call.done) return;
          call.reply({ t: 'result', id: call.id, ok: false, error: encodeError(error) });
        },
      ).finally(() => {
        active--;
        call.done = true;
        if (call.timer) clearTimeout(call.timer);
        running.delete(tracked);
        pump();
      });
      running.add(tracked);
    }
  };

  const hello: OwnerHello = {
    t: 'hello', version: OWNER_IPC_VERSION, pid: process.pid, kind: String(engine.kind),
    capabilities: [...((engine as { capabilities?: Iterable<string> }).capabilities ?? [])].map(String),
    serve: opts.serve === true,
  };

  const onConnection = (socket: Socket) => {
    socket.on('error', () => { /* a lost client only ends its own calls */ });
    if (closing) { socket.destroy(); return; }
    sockets.add(socket);
    const calls = new Map<number, PendingCall>();
    const send = (frame: object) => {
      if (socket.destroyed) return;
      const line = frameLine(frame, maxFrameBytes);
      if (line !== null) { socket.write(line); return; }
      const id = (frame as { id?: number }).id;
      const call = id === undefined ? undefined : calls.get(id);
      if ((frame as { t?: string }).t === 'result' && call) {
        socket.write(frameLine({ t: 'result', id, ok: false, error: encodeError(ownerResponseTooLarge(call.member, maxFrameBytes)) })!);
      }
    };
    socket.once('close', () => {
      sockets.delete(socket);
      for (const call of calls.values()) { call.done = true; call.controller.abort(new DOMException('The client closed its connection.', 'AbortError')); }
      calls.clear();
      lanes.delete(calls);
    });
    readFrames(socket, frame => {
      switch (frame.t) {
        case 'hello': send(hello); return;
        case 'cancel': {
          const call = calls.get(Number(frame.id));
          if (!call) return;
          calls.delete(call.id);
          call.done = true;
          if (call.timer) clearTimeout(call.timer);
          call.controller.abort(new DOMException('The caller cancelled the call.', 'AbortError'));
          return;
        }
        case 'call': case 'fn': admit(frame, calls, send); return;
        default: socket.destroy();
      }
    }, () => { /* the close handler ends this connection's calls */ }, maxFrameBytes);
  };

  const admit = (frame: Record<string, unknown>, calls: Map<number, PendingCall>, send: (frame: object) => void) => {
    const id = Number(frame.id);
    const member = String(frame.t === 'fn' ? frame.name : frame.member);
    const controller = new AbortController();
    const call: PendingCall = {
      id, member, controller, done: false, queued: true, run: () => Promise.resolve(),
      reply: out => { if (calls.get(id) === call) calls.delete(id); call.done = true; send(out); },
    };
    calls.set(id, call);
    const refuse = (error: unknown) => call.reply({ t: 'result', id, ok: false, error: encodeError(error) });
    let target: (...args: unknown[]) => Promise<unknown>;
    if (frame.t === 'fn') {
      const operation = Object.hasOwn(wholeOperations, member) ? wholeOperations[member] : undefined;
      if (!operation) { refuse(ownerIpcRefusal(member, 'the owner does not run this operation for other processes')); return; }
      target = (...args) => operation(engine, ...args);
    } else {
      const route = (OWNER_IPC_ROUTES as Record<string, string>)[member];
      const method = (engine as unknown as Record<string, unknown>)[member];
      if (route !== 'forward' || typeof method !== 'function') { refuse(ownerIpcRefusal(member, 'it is not sent across the owner socket')); return; }
      target = (...args) => (method as (...a: unknown[]) => Promise<unknown>).apply(engine, args);
    }
    let args: unknown[];
    try {
      const decoded = decodeValue((frame.args ?? []) as Wire, {
        onFunction: wire => rebuildFunction(wire, call, send),
        onSignal: () => controller.signal,
      });
      args = Array.isArray(decoded) ? decoded : [];
    } catch (error) { refuse(error); return; }
    const deadlineAt = typeof frame.deadline_at === 'number' ? frame.deadline_at : undefined;
    const readDeadlineAt = typeof frame.read_deadline_at === 'number' ? frame.read_deadline_at : undefined;
    call.run = () => withRequestSignal(controller.signal, () =>
      readDeadlineAt === undefined ? target(...args) : withReadDeadline(readDeadlineAt, () => target(...args)));
    if (deadlineAt !== undefined) {
      call.deadlineAt = deadlineAt;
      // A request that arrives after its deadline never starts: a fast write would otherwise commit before the timer.
      if (Date.now() >= deadlineAt) { expire(call, true); return; }
      const ms = Math.max(0, deadlineAt - Date.now());
      call.timer = setTimeout(() => {
        if (call.done) return;
        const queued = call.queued;
        call.reply({ t: 'result', id, ok: false, error: encodeError(ownerCallTimeout(member, ms, queued)) });
        controller.abort(timeoutReason());
      }, ms);
      call.timer.unref?.();
    }
    const lane = lanes.get(calls);
    if (lane) lane.push(call); else lanes.set(calls, [call]);
    pump();
  };

  const server: Server = net.createServer(onConnection);
  server.once('close', () => { void binding.release(); });
  let listened = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        listened = true;
        server.off('error', reject);
        server.on('error', () => {});
        try { if (process.platform !== 'win32') chmodSync(socketPath, 0o600); resolve(); }
        catch (error) { reject(error); }
      });
    });
  } catch (error) {
    if (listened) server.close(); else await binding.release();
    throw error;
  }

  return {
    socketPath,
    stats: () => ({ active, queued: [...lanes.values()].reduce((sum, calls) => sum + calls.filter(call => !call.done).length, 0), connections: sockets.size }),
    // Stops new work, aborts every queued and running call, and resolves only when the server is closed AND every
    // engine call that started has settled, so the caller cannot release the owner lock while old work still runs.
    // A second close() gets the same promise, so no caller can release the lock before the drain ends.
    close: () => (closed ??= (async () => {
      closing = true;
      const serverClosed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const calls of lanes.values()) {
        for (const call of calls) {
          if (!call.done) { call.done = true; call.controller.abort(new DOMException('The brain owner is closing.', 'AbortError')); }
        }
      }
      lanes.clear();
      for (const socket of sockets) socket.destroy();
      while (running.size) await Promise.allSettled([...running]);
      await serverClosed;
    })()),
  };
}
