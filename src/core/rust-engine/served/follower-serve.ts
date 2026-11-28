/**
 * Following a Rust primary over protocol v3 (multi-user Rust; docs/designs/rust-engine/multi-user-server.md, "Follower
 * frames"). Two halves:
 *
 * - `primaryFollowerSession` (the primary, inside one v3 session, served/session.ts): offered as capability `follower`
 *   only when the session's served options carry `follower` (multi-user mode on), the connection is a network one, its
 *   principal is an owner server token (A1), the client asked for it, and the brain keeps a commit log. A client that
 *   does not ask gets the hello it always got. After the client's `repl_follow { cursor }` the send loop reads the commit
 *   log after the cursor (`readCommitLogRaw`), sends `repl_records`, and waits for each `repl_ack`. When the log cannot
 *   continue the cursor, or the follower answers `snapshot_required`, it streams a whole snapshot with at most
 *   `windowBytes` (64 MiB) of chunk bytes past the follower's last `repl_snap_window`. A store refusal it cannot get
 *   past ends the connection with a `refused` frame carrying the error.
 * - Replica acks (rust/docs/store/commit-log.md, "Replica acks"): a `repl_follow` that names a `replica` id attaches
 *   it (`Brain#attachReplica`, idempotent), and the primary's served writes then wait for its acks (replica-gate.ts).
 *   An ack counts only when it can be true: a records ack that is `ok`, answers the frame sent (`seq`) and whose cursor
 *   is that frame's last record; a snapshot ack whose cursor is at the snapshot's commit sequence (its manifest's
 *   `generation`); and, on (re)connect, the `repl_follow` cursor with a `lineage` the store accepts. Each counted ack
 *   is reported (`Brain#reportReplicaAck`, the attach generation), wakes the gate, and is told back as `repl_mark`.
 *   `repl_detach` (any owner-token connection that asked for `follower`) detaches a replica (`Brain#detachReplica`).
 *   A follower that names no replica attaches nothing, and writes never wait for it.
 * - `followPrimary` (the follower): connects with an owner server token, asks for `follower`, sends its cursor
 *   (`Follower#cursor`), and hands every frame to a FollowerApplier (follower-apply.ts), which calls L2's napi. After a
 *   dropped connection it reconnects and sends its cursor again, so the primary resumes after what it holds: nothing is
 *   applied twice. The follower is opened by its owner with `Follower.open`; this module never opens one.
 */
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { opError } from '../../ops/contract.ts';
import { decodeError, type Wire } from '../owner-ipc/codec.ts';
import { OWNER_IPC_VERSION_V3 } from '../owner-ipc/protocol.ts';
import { openSocket, parseServedUrl } from './client.ts';
import { encodeError } from '../owner-ipc/codec.ts';
import { servedProtocol } from './errors.ts';
import { FollowerApplier, primaryRecordsFrame, primarySnapshotStream, type FollowerNapi } from './follower-apply.ts';
import {
  FOLLOWER_CAP, SNAPSHOT_CHUNK_BYTES, SNAPSHOT_FILES, SNAPSHOT_WINDOW_BYTES, decodeReplDetach, decodeReplFollow, decodeReplMark,
  encodeReplDetach, encodeReplFollow, encodeReplMark, type CommitPositionWire, type TimelineWire,
} from './follower-frames.ts';
import { byteBudget, encodeLengthFrame, readLengthFrames, SERVED_MAX_FRAME_BYTES } from './framing.ts';
import type { RustStore } from '../store.ts';

export interface FollowerServeOptions {
  /** How long the send loop waits before reading the log again when the follower is caught up (default 200 ms). */
  pollMs?: number;
  /** Records per `repl_records` frame (default 256). */
  maxRecords?: number;
  chunkBytes?: number;
  windowBytes?: number;
  /** Where the primary's snapshot copies are made (default the system temporary directory). */
  stagingDir?: string;
  /** Test seam: every chunk the loop sends, with the chunk bytes then unacknowledged and whether it had to wait. */
  onStats?(stats: { unacked: number; waited: boolean }): void;
}

type Frame = { header: Record<string, unknown>; tail: Buffer | null };

export interface PrimaryFollowerSession {
  onFrame(header: Record<string, unknown>, tail: Buffer | null): void;
  close(): void;
}

/** An error for the network: without stack or cause (session.ts encodeErr). */
function wireError(error: unknown): Wire {
  const wire = encodeError(error);
  if (!wire || typeof wire !== 'object' || Array.isArray(wire) || !Array.isArray(wire.props)) return wire;
  return { ...wire, props: (wire.props as Wire[]).filter(p => !(Array.isArray(p) && (p[0] === 'stack' || p[0] === 'cause'))) };
}

function positionOf(v: unknown): CommitPositionWire | null {
  if (v === null || v === undefined) return null;
  const p = v as { sequence?: unknown; index?: unknown };
  if (!Number.isSafeInteger(p.sequence) || !Number.isSafeInteger(p.index) || (p.sequence as number) < 0 || (p.index as number) < 0 || (p.index as number) > 0xffff_ffff) {
    throw servedProtocol('frame_malformed', 'reason=repl_follow_cursor');
  }
  return { sequence: p.sequence as number, index: p.index as number };
}

/** The primary side on one connection, or null when this connection may not follow (module docs). */
export function primaryFollowerSession(ctx: {
  engine: object; principal: { kind: string }; network: boolean; offered: boolean; opts: FollowerServeOptions | undefined;
  socket: Socket; refuse(error: unknown): void; log?: (line: string) => void;
  /** The server's replica gate (session.ts): woken after each counted ack, attach and detach. */
  gate?: { wake(): void; nap(ms: number): Promise<void> };
}): PrimaryFollowerSession | null {
  if (!ctx.opts || !ctx.offered || !ctx.network || ctx.principal.kind !== 'owner_token') return null;
  const store = (ctx.engine as { openStoreIfOpen?: (member: string) => RustStore | null }).openStoreIfOpen?.('follower') ?? null;
  if (!store?.commitLog) return null;
  const opts = ctx.opts;
  const windowBytes = opts.windowBytes ?? SNAPSHOT_WINDOW_BYTES;
  let closed = false;
  let started = false;
  const ackWaiters = new Map<number, (ack: Record<string, unknown>) => void>();
  let windowWake: (() => void) | null = null;
  let window = { xfer: '', file: '', through: 0 };
  // The replica this connection follows for, with the generation its attach returned (null: a plain follower).
  let replica: { id: string; generation: number } | null = null;
  const replicasOn = store.multiuser && typeof store.brain.attachReplica === 'function';

  /** Reports one ack that can be true (module docs); a refusal is logged and not counted. */
  const report = async (cursor: CommitPositionWire | null, lineage: TimelineWire[] | null) => {
    const r = replica;
    if (!r || !cursor) return;
    try {
      const acked = await store.brain.reportReplicaAck(r.id, r.generation, cursor, lineage) as CommitPositionWire | null;
      ctx.gate?.wake();
      if (acked && !closed && replica === r) send(encodeReplMark(acked), null);
    } catch (error) {
      ctx.log?.(`[gbrain serve] replica ${r.id} ack at cp1:${cursor.sequence}.${cursor.index} not counted: ${(error as Error)?.message ?? String(error)}`);
    }
  };
  const lastPosition = (header: Record<string, unknown>): CommitPositionWire | null => {
    const records = header.records as Array<{ sequence: number; index: number }> | undefined;
    const last = records?.[records.length - 1];
    return last ? { sequence: last.sequence, index: last.index } : null;
  };
  const samePosition = (a: CommitPositionWire | null, b: CommitPositionWire | null) =>
    !!a && !!b && a.sequence === b.sequence && a.index === b.index;

  const send = (header: Record<string, unknown>, tail: Buffer | null) => {
    const buf = encodeLengthFrame(header, tail, SERVED_MAX_FRAME_BYTES);
    if (!buf) throw servedProtocol('frame_malformed', 'reason=repl_frame_too_large');
    if (!ctx.socket.destroyed) ctx.socket.write(buf);
  };
  const nextAck = (seq: number) => new Promise<Record<string, unknown>>((resolve, reject) => {
    if (closed) { reject(new Error('closed')); return; }
    ackWaiters.set(seq, resolve);
  });
  const sleep = (ms: number) => new Promise<void>(r => { const t = setTimeout(r, ms); t.unref?.(); });

  // The commit sequence of the snapshot being sent (its manifest's generation): a snapshot ack counts only there.
  let snapshotSequence: number | null = null;
  const sendSnapshot = async (n: number): Promise<Record<string, unknown>> => {
    const xfer = `snap-${n}`;
    const sizes = new Map<string, number>();
    let sent = 0;
    window = { xfer, file: '', through: 0 };
    const acked = () => {
      if (window.xfer !== xfer || window.file === '') return 0;
      let total = 0;
      for (const name of SNAPSHOT_FILES) { if (name === window.file) break; total += sizes.get(name) ?? 0; }
      return total + window.through;
    };
    for await (const frame of primarySnapshotStream(store, { id: 2, xfer, chunkBytes: opts.chunkBytes ?? SNAPSHOT_CHUNK_BYTES, stagingDir: opts.stagingDir ?? tmpdir() })) {
      if (closed) throw new Error('closed');
      if (frame.header.t === 'repl_snap_begin') {
        for (const f of frame.header.files as Array<{ name: string; bytes: number }>) sizes.set(f.name, f.bytes);
        snapshotSequence = Number((frame.header.manifest as { generation?: unknown }).generation);
      }
      const len = frame.tail?.length ?? 0;
      let waited = false;
      // Never more than the window past what the follower has written (one chunk always goes, so a window smaller than
      // a chunk still moves).
      while (!closed && len > 0 && sent - acked() > 0 && sent - acked() + len > windowBytes) {
        waited = true;
        await new Promise<void>(r => { windowWake = r; });
      }
      if (closed) throw new Error('closed');
      send(frame.header, frame.tail);
      if (len > 0) { sent += len; opts.onStats?.({ unacked: sent - acked(), waited }); }
    }
    return nextAck(0);
  };

  const loop = async (from: CommitPositionWire | null) => {
    let cursor = from;
    let seq = 0;
    let snapshots = 0;
    // An empty follower (no cursor) holds nothing a records frame could continue: start with the snapshot.
    let needSnapshot = cursor === null;
    while (!closed) {
      if (needSnapshot) {
        needSnapshot = false;
        const ack = await sendSnapshot(++snapshots);
        if (ack.ok !== true) throw decodeError(ack.error as Wire);
        cursor = positionOf(ack.cursor);
        if (cursor && cursor.sequence === snapshotSequence) await report(cursor, null);
        continue;
      }
      // The log cannot continue the cursor: the store's `snapshot_required` sends a snapshot; anything else ends the loop.
      const read = await primaryRecordsFrame(store, cursor, opts.maxRecords ?? 256, 1, seq + 1)
        .then(frame => ({ frame }), (error: unknown) => ({ error }));
      if ('error' in read) {
        if ((read.error as { code?: unknown }).code !== 'snapshot_required') throw read.error;
        needSnapshot = true;
        continue;
      }
      const frame: Frame | null = read.frame;
      if (!frame) { await (ctx.gate ? ctx.gate.nap(opts.pollMs ?? 200) : sleep(opts.pollMs ?? 200)); continue; }
      seq++;
      send(frame.header, frame.tail);
      const ack = await nextAck(seq);
      if (ack.ok === true) {
        cursor = positionOf(ack.cursor);
        if (ack.seq === seq && samePosition(cursor, lastPosition(frame.header))) await report(cursor, null);
        continue;
      }
      const error = decodeError(ack.error as Wire) as { code?: unknown };
      // A follower holding records the primary does not have takes a snapshot only after it exported them
      // (`diverged_tail`, rust/docs/store/commit-log.md, "Diverged tail recovery"): its install refuses until then.
      if (error.code === 'snapshot_required' || error.code === 'diverged_tail') { needSnapshot = true; continue; }
      throw error;
    }
  };

  return {
    onFrame: (header) => {
      if (closed) return;
      if (header.t === 'repl_follow') {
        if (started) { ctx.refuse(servedProtocol('frame_malformed', 'reason=second_repl_follow')); return; }
        started = true;
        let follow: ReturnType<typeof decodeReplFollow>;
        try { follow = decodeReplFollow(header); } catch (error) { ctx.refuse(error); return; }
        const from = follow.cursor;
        const begin = async () => {
          if (follow.replica !== undefined && replicasOn) {
            const attached = await store.brain.attachReplica(follow.replica) as { generation: number };
            replica = { id: follow.replica, generation: Number(attached.generation) };
            ctx.gate?.wake();
            // What the follower already holds counts once its history is shown to continue the primary's.
            if (follow.lineage) await report(from, follow.lineage);
          }
          await loop(from);
        };
        void begin().catch((error: unknown) => {
          if (closed) return;
          ctx.log?.(`[gbrain serve] follower stopped: ${(error as Error)?.message ?? String(error)}`);
          ctx.refuse(error);
        });
        return;
      }
      if (header.t === 'repl_ack') {
        const seq = typeof header.seq === 'number' ? header.seq : -1;
        const waiter = ackWaiters.get(seq);
        if (waiter) { ackWaiters.delete(seq); waiter(header); }
        return;
      }
      if (header.t === 'repl_detach') {
        let detach: { replica: string; reason: string };
        try { detach = decodeReplDetach(header); } catch (error) { ctx.refuse(error); return; }
        void (async () => {
          try {
            if (!replicasOn) throw servedProtocol('frame_malformed', 'reason=replica_acks_off');
            const detached = await store.brain.detachReplica(detach.replica, detach.reason) as boolean;
            if (replica?.id === detach.replica) replica = null;
            ctx.gate?.wake();
            if (!closed) send({ t: 'repl_detached', replica: detach.replica, detached }, null);
          } catch (error) {
            if (!closed) send({ t: 'repl_detached', replica: detach.replica, detached: false, error: wireError(error) }, null);
          }
        })();
        return;
      }
      if (header.t === 'repl_snap_window' && typeof header.xfer === 'string' && typeof header.file === 'string' && Number.isSafeInteger(header.through)) {
        window = { xfer: header.xfer, file: header.file, through: header.through as number };
        const wake = windowWake; windowWake = null; wake?.();
      }
    },
    close: () => {
      closed = true;
      ackWaiters.clear();
      const wake = windowWake; windowWake = null; wake?.();
    },
  };
}

// ---- the follower ----

export interface FollowPrimaryOptions {
  url: string;
  token: string;
  ca?: string | Buffer;
  /** L2's napi Follower, opened by the caller with `Follower.open`. */
  follower: FollowerNapi & {
    cursor(): Promise<CommitPositionWire | null>;
    lineage?(): Promise<TimelineWire[]>;
    notePrimaryAcked?(position: CommitPositionWire): Promise<boolean>;
  };
  /**
   * This follower's replica id: the primary attaches it, and its served writes wait for this follower's acks
   * (rust/docs/store/commit-log.md, "Replica acks"). Absent: a plain follower writes never wait for.
   */
  replica?: string;
  /**
   * A directory (absent until used) for this follower's diverged tail: when the follower holds records the primary
   * does not have, it exports them there, complete, and only then takes the primary's snapshot over them
   * (rust/docs/store/commit-log.md, "Diverged tail recovery"). Absent: such a follower stops with `diverged_tail`.
   */
  divergedTailExport?: string;
  /** Where received snapshots are staged before install (a private directory of the follower). */
  stagingDir: string;
  /** The brain this follower follows; learned from the primary's first frame when absent. */
  brainId?: string;
  maxBytes?: number;
  timeoutMs?: number;
  /** Every `repl_ack` the follower sends (tests, monitoring). */
  onAck?(ack: Record<string, unknown>): void;
  /** Every replication frame the follower receives, before it is applied (tests, monitoring). */
  onFrame?(header: Record<string, unknown>): void;
  /** Why following stopped for good (a refusal the follower cannot get past). */
  onStop?(error: unknown): void;
}

export interface FollowerLink {
  close(): Promise<void>;
  /**
   * Asks the primary to stop waiting for `replica` (default this link's own `replica`); resolves whether a detach
   * was committed. Refused when the link is down.
   */
  detach(reason: string, replica?: string): Promise<boolean>;
  /** Test seam: drops the current connection; the follower reconnects and resumes. */
  drop(): void;
  /** Connections made so far. */
  readonly connections: number;
}

/**
 * Connects to the primary and follows it until `close()`. Resolves once the first connection's hello offered
 * `follower`; rejects with the primary's refusal (`permission_denied` for a token that is not an owner server token) or
 * `engine_capability_missing` reason `follower` when the primary does not offer it.
 */
export async function followPrimary(opts: FollowPrimaryOptions): Promise<FollowerLink> {
  const endpoint = parseServedUrl(opts.url);
  if (endpoint.kind === 'unix') throw opError('config_error', 'A follower follows a brain server over the network.', 'Use a gbrain+tls:// or gbrain+tcp:// URL.');
  let socket: Socket | null = null;
  let closed = false;
  let connections = 0;
  let brainId = opts.brainId;
  let applier: FollowerApplier | null = null;
  let chain: Promise<void> = Promise.resolve();
  let reconnecting = false;
  let write: ((header: Record<string, unknown>, tail: Buffer | null) => void) | null = null;
  const detachWaiters = new Map<string, Array<(header: Record<string, unknown>) => void>>();

  const applierFor = (header: Record<string, unknown>): FollowerApplier => {
    if (!brainId) {
      const fromHeader = typeof header.brain_id === 'string' ? header.brain_id
        : typeof (header.manifest as { brain_id?: unknown } | undefined)?.brain_id === 'string' ? (header.manifest as { brain_id: string }).brain_id : undefined;
      if (fromHeader) brainId = fromHeader;
    }
    return (applier ??= new FollowerApplier(opts.follower, {
      brainId: brainId ?? '', stagingDir: opts.stagingDir, maxBytes: opts.maxBytes ?? Number.MAX_SAFE_INTEGER,
      ...(opts.divergedTailExport !== undefined ? { divergedTailExport: opts.divergedTailExport } : {}),
    }));
  };

  const connectOnce = (): Promise<void> => new Promise((resolve, reject) => {
    void openSocket(endpoint, { ...(opts.ca ? { ca: opts.ca } : {}), timeoutMs: opts.timeoutMs ?? 5_000 }).then(s => {
      let answered = false;
      const timer = setTimeout(() => { if (!answered) { answered = true; s.destroy(); reject(servedProtocol('hello_timeout', 'side=follower')); } }, opts.timeoutMs ?? 5_000);
      const writeOn = (header: Record<string, unknown>, tail: Buffer | null) => { if (!s.destroyed) s.write(encodeLengthFrame(header, tail, SERVED_MAX_FRAME_BYTES)!); };
      readLengthFrames(s, {
        maxFrameBytes: () => SERVED_MAX_FRAME_BYTES, budget: byteBudget(Number.MAX_SAFE_INTEGER), onBad: () => {},
        onFrame: (header, tail) => {
          if (!answered) {
            answered = true;
            clearTimeout(timer);
            if (header.t === 'refused') { s.destroy(); reject(decodeError(header.error as Wire)); return; }
            const caps = Array.isArray(header.caps) ? header.caps : [];
            if (header.t !== 'hello' || !caps.includes(FOLLOWER_CAP)) {
              s.destroy();
              reject(opError('engine_capability_missing', 'The brain server does not offer following.', 'Turn multi-user Rust and its commit log on at the server, and connect with an owner server token.', { reason: 'follower' }));
              return;
            }
            socket = s;
            write = writeOn;
            connections++;
            void (async () => {
              const cursor = await opts.follower.cursor();
              const lineage = opts.replica !== undefined && cursor && opts.follower.lineage ? await opts.follower.lineage() : undefined;
              writeOn(encodeReplFollow({ id: 1, cursor, ...(opts.replica !== undefined ? { replica: opts.replica } : {}), ...(lineage ? { lineage } : {}) }), null);
            })().catch((error: unknown) => { opts.onStop?.(error); s.destroy(); });
            resolve();
            return;
          }
          if (header.t === 'refused') {
            const error = decodeError(header.error as Wire);
            closed = true;
            opts.onStop?.(error);
            s.destroy();
            return;
          }
          opts.onFrame?.(header);
          if (header.t === 'repl_detached') {
            const replica = String(header.replica);
            const waiter = detachWaiters.get(replica)?.shift();
            waiter?.(header);
            return;
          }
          if (header.t === 'repl_mark') {
            // Kept in order with the records it follows; a mark the store does not take is not fatal.
            chain = chain.then(async () => {
              const acked = decodeReplMark(header);
              await opts.follower.notePrimaryAcked?.(acked);
            }).catch(() => undefined);
            return;
          }
          chain = chain.then(async () => {
            const replies = await applierFor(header).onFrame(header, tail);
            for (const reply of replies) {
              if (reply.header.t === 'repl_ack') opts.onAck?.(reply.header);
              writeOn(reply.header, reply.tail);
            }
          }).catch((error: unknown) => { opts.onStop?.(error); s.destroy(); });
        },
      });
      s.on('error', () => {});
      s.once('close', () => {
        clearTimeout(timer);
        if (write === writeOn) write = null;
        for (const [replica, waiters] of detachWaiters) {
          for (const w of waiters.splice(0)) w({ t: 'repl_detached', replica, detached: false, error: null });
        }
        if (!answered) { answered = true; reject(servedProtocol('hello_timeout', 'side=follower closed=true')); return; }
        if (socket === s) { socket = null; void reconnect(); }
      });
      writeOn({ t: 'hello', v: OWNER_IPC_VERSION_V3, version: OWNER_IPC_VERSION_V3, caps: [FOLLOWER_CAP], auth: { scheme: 'bearer', token: opts.token } }, null);
    }, reject);
  });

  /** After a drop: reconnect with backoff until it works or `close()`; the cursor is sent again on the new connection. */
  const reconnect = async () => {
    if (closed || reconnecting) return;
    reconnecting = true;
    try {
      // Frames of the lost connection finish first, so the cursor sent next is the follower's own.
      await chain;
      await applier?.close();
      for (let wait = 50; !closed; wait = Math.min(1000, wait * 2)) {
        try { await connectOnce(); return; }
        catch (error) {
          if ((error as { code?: unknown }).code === 'permission_denied') { closed = true; opts.onStop?.(error); return; }
          await new Promise(r => setTimeout(r, wait));
        }
      }
    } finally { reconnecting = false; }
  };

  await connectOnce();
  return {
    get connections() { return connections; },
    detach: (reason: string, replica = opts.replica) => new Promise<boolean>((resolve, reject) => {
      if (replica === undefined) { reject(opError('invalid_params', 'This follower names no replica to detach.', 'Pass the replica id to detach.')); return; }
      const send = write;
      if (!send) { reject(servedProtocol('frame_malformed', 'reason=follower_link_down')); return; }
      const frame = encodeReplDetach(replica, reason);
      decodeReplDetach(frame);
      const list = detachWaiters.get(replica) ?? [];
      list.push(header => {
        if (header.error) { reject(decodeError(header.error as Wire)); return; }
        if (header.detached === false && header.error === null) { reject(servedProtocol('frame_malformed', 'reason=follower_link_down')); return; }
        resolve(header.detached === true);
      });
      detachWaiters.set(replica, list);
      send(frame, null);
    }),
    drop: () => { socket?.destroy(); },
    close: async () => {
      closed = true;
      socket?.destroy();
      await chain.catch(() => undefined);
      await applier?.close();
    },
  };
}


/**
 * The one-shot detach (rust/docs/store/commit-log.md, "Replica acks", detach runbook): connects to the primary as a
 * follower connection would (owner server token, capability `follower`), sends `repl_detach` without following, and
 * resolves whether a detach was committed (false: the id was not attached). Refusals reject with the store's error.
 */
export async function detachReplicaAt(opts: {
  url: string; token: string; ca?: string | Buffer; replica: string; reason: string; timeoutMs?: number;
}): Promise<boolean> {
  const frame = encodeReplDetach(opts.replica, opts.reason);
  decodeReplDetach(frame);
  const endpoint = parseServedUrl(opts.url);
  if (endpoint.kind === 'unix') throw opError('config_error', 'A replica is detached over the network.', 'Use a gbrain+tls:// or gbrain+tcp:// URL.');
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const s = await openSocket(endpoint, { ...(opts.ca ? { ca: opts.ca } : {}), timeoutMs });
  return new Promise<boolean>((resolve, reject) => {
    let helloed = false;
    let ended = false;
    const end = (fn: () => void) => { if (ended) return; ended = true; clearTimeout(timer); s.destroy(); fn(); };
    const timer = setTimeout(() => end(() => reject(servedProtocol('hello_timeout', helloed ? 'side=detach answered=false' : 'side=detach'))), timeoutMs);
    const write = (header: Record<string, unknown>) => { if (!s.destroyed) s.write(encodeLengthFrame(header, null, SERVED_MAX_FRAME_BYTES)!); };
    readLengthFrames(s, {
      maxFrameBytes: () => SERVED_MAX_FRAME_BYTES, budget: byteBudget(Number.MAX_SAFE_INTEGER), onBad: () => {},
      onFrame: header => {
        if (!helloed) {
          helloed = true;
          if (header.t === 'refused') { end(() => reject(decodeError(header.error as Wire))); return; }
          const caps = Array.isArray(header.caps) ? header.caps : [];
          if (header.t !== 'hello' || !caps.includes(FOLLOWER_CAP)) {
            end(() => reject(opError('engine_capability_missing', 'The brain server does not offer following, so it has no replicas.', 'Turn multi-user Rust and its commit log on at the server, and connect with an owner server token.', { reason: 'follower' })));
            return;
          }
          write(frame);
          return;
        }
        if (header.t === 'refused') { end(() => reject(decodeError(header.error as Wire))); return; }
        if (header.t !== 'repl_detached' || header.replica !== opts.replica) return;
        if (header.error) { const error = decodeError(header.error as Wire); end(() => reject(error)); return; }
        end(() => resolve(header.detached === true));
      },
    });
    s.on('error', () => {});
    s.once('close', () => end(() => reject(servedProtocol('hello_timeout', 'side=detach closed=true'))));
    write({ t: 'hello', v: OWNER_IPC_VERSION_V3, version: OWNER_IPC_VERSION_V3, caps: [FOLLOWER_CAP], auth: { scheme: 'bearer', token: opts.token } });
  });
}
