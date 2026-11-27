/**
 * Owner socket bounds (src/core/rust-engine/owner-ipc/server.ts): the owner caps how many calls wait in its queue, how
 * many bytes of call frames it holds at once, and how many connections it keeps, and refuses past each cap with
 * `owner_busy` before anything runs.
 *
 * 1. Protects: one same-user peer cannot grow the owner's memory without limit by queueing calls, sending large
 *    argument frames, or opening connections; a refused call never runs, and a freed slot or freed bytes admit the
 *    next call again.
 * 2. Fails on: a server that queues every call, holds every frame's bytes with no total, keeps every connection, or
 *    never gives back a slot or bytes when a call is cancelled or settles.
 * 3. Existing coverage: rust-owner-ipc.test.ts covers permits, deadlines and the frame cap per frame; nothing bounds the
 *    queue, the total bytes or the connections.
 * 4. Seam: the `maxQueued`, `maxInflightBytes` and `maxConnections` options of `serveOwnerEngine`, so the caps are
 *    reached with a few small calls. Everything else is raw frames on a real socket.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import type { BrainEngine } from '../src/core/engine.ts';
import { serveOwnerEngine, type OwnerServerOptions } from '../src/core/rust-engine/owner-ipc/server.ts';
import { connectOwner } from '../src/core/rust-engine/owner-ipc/client.ts';
import { OWNER_IPC_REFUSED_DRAIN_MS, OWNER_IPC_REFUSED_LIMIT, OWNER_IPC_VERSION } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { decodeError, encodeValue, type Wire } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { requestSignal } from '../src/core/request-signal.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { CODES } from '../src/core/error-registry.ts';
import { rawSession, type Frame } from './helpers/owner-ipc-raw.ts';

const errorOf = (frame: Frame | null | undefined) => decodeError(frame?.error as Wire) as OperationError;
const hello = { t: 'hello', version: OWNER_IPC_VERSION };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

/** An owner whose getHealth runs until its call is cancelled, and whose getConfig answers at once. */
async function blockingOwner(opts: OwnerServerOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-limits-'));
  const ran: string[] = [];
  const owner = {
    kind: 'pglite', capabilities: new Set<string>(),
    getHealth: (tag: unknown) => {
      ran.push(`getHealth:${String(tag).slice(0, 12)}`);
      return new Promise((_resolve, reject) => {
        requestSignal()?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
    getConfig: async (key: unknown) => { ran.push(`getConfig:${String(key)}`); return 'value'; },
  } as unknown as BrainEngine;
  const server = await serveOwnerEngine(owner, join(dir, 'owner.sock'), opts);
  if (!server) throw new Error('no socket');
  cleanups.push(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { server, ran };
}

const call = (id: number, member: string, args: unknown[]) => ({ t: 'call', id, member, args: encodeValue(args) });

/** An owner whose getHealth ignores its abort and settles only when `release` runs; getConfig answers at once. */
async function gatedOwner(opts: OwnerServerOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-limits-gated-'));
  const ran: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const owner = {
    kind: 'pglite', capabilities: new Set<string>(),
    getHealth: async (tag: unknown) => { ran.push(`getHealth:${String(tag).slice(0, 12)}`); await gate; return 'settled'; },
    getConfig: async (key: unknown) => { ran.push(`getConfig:${String(key)}`); return 'value'; },
  } as unknown as BrainEngine;
  const server = await serveOwnerEngine(owner, join(dir, 'owner.sock'), opts);
  if (!server) throw new Error('no socket');
  cleanups.push(async () => { release(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { server, ran, release };
}

/** Polls `done` every 25 ms for up to 2 s; the caller asserts the state it waited for. */
async function until(done: () => boolean): Promise<void> { for (let i = 0; i < 80 && !done(); i++) await Bun.sleep(25); }

describe('the owner queue cap', () => {
  test('a call past maxQueued is refused with owner_busy queue_full and never runs; a cancelled call frees its slot', async () => {
    const { server, ran } = await blockingOwner({ permits: 1, maxQueued: 2 });
    const raw = rawSession(server.socketPath);
    cleanups.push(() => { raw.destroy(); });
    await raw.send(hello);
    await raw.send(call(1, 'getHealth', ['running']));
    await raw.send(call(2, 'getHealth', ['queued-a']));
    await raw.send(call(3, 'getHealth', ['queued-b']));
    await raw.send(call(4, 'getConfig', ['over']));
    const refused = await raw.next(f => f.t === 'result' && f.id === 4);
    const error = errorOf(refused);
    expect({ code: error.code, reason: error.reason, retryable: error.retryable }).toEqual({ code: 'owner_busy', reason: 'queue_full', retryable: true });
    expect(error.detail).toContain('member=getConfig');
    expect(error.detail).toContain('limit=2');
    expect(ran).not.toContain('getConfig:over');
    expect(server.stats().queued).toBe(2);
    // Cancelling a queued call gives its slot back at once.
    await raw.send({ t: 'cancel', id: 2 });
    for (let i = 0; i < 40 && server.stats().queued !== 1; i++) await Bun.sleep(25);
    await raw.send(call(5, 'getHealth', ['queued-c']));
    await Bun.sleep(100);
    expect(raw.frames.find(f => f.id === 5)).toBeUndefined();
    expect(server.stats().queued).toBe(2);
  });
});

describe('the owner queue slot and bytes of a call that ends without running', () => {
  for (const exit of ['its deadline passes while queued', 'its client disconnects', 'the server closes'] as const) {
    // Value: protects=a queued call that times out, loses its client or meets close() returns its slot and bytes once; fails_when=an exit path skips or repeats the release; why_new=only a queued cancel was covered, not timeout, disconnect or close; seam=none; no_claim=running calls
    test(`a queued call whose ${exit.replace('its ', '').replace('the ', '')} gives back its queue slot and its bytes exactly once`, async () => {
      const { server, ran } = await blockingOwner({ permits: 1, maxQueued: 1 });
      const running = rawSession(server.socketPath);
      const waiting = rawSession(server.socketPath);
      cleanups.push(() => { running.destroy(); waiting.destroy(); });
      await running.send(hello);
      await running.send(call(1, 'getHealth', ['running']));
      await until(() => server.stats().active === 1);
      const base = server.stats();
      expect(base).toMatchObject({ active: 1, queued: 0 });
      // The deadline case carries a deadline_at on every frame (a short one first), so each frame has the same size.
      const queuedFrame = (id: number, ms: number) => ({ ...call(id, 'getHealth', ['q'.repeat(400)]), ...(exit === 'its deadline passes while queued' ? { deadline_at: Date.now() + ms } : {}) });
      await waiting.send(hello);
      await waiting.send(queuedFrame(2, 150));
      await until(() => server.stats().queued === 1);
      const held = server.stats().inflightBytes - base.inflightBytes;
      expect(held).toBeGreaterThan(400);
      expect(server.stats().queued).toBe(1);
      if (exit === 'its deadline passes while queued') {
        const ended = errorOf(await waiting.next(f => f.t === 'result' && f.id === 2));
        expect({ code: ended.code, reason: ended.reason }).toMatchObject({ code: 'timeout' });
      } else if (exit === 'its client disconnects') {
        waiting.destroy();
      } else {
        await server.close();
        // Nothing is left: a slot or byte returned twice would show as a negative count here.
        expect(server.stats()).toMatchObject({ active: 0, queued: 0, inflightBytes: 0 });
        expect(ran.filter(r => r.startsWith('getHealth'))).toEqual(['getHealth:running']);
        return;
      }
      await until(() => server.stats().queued === 0);
      // The slot and the bytes are back, once: the running call's bytes alone are held.
      expect(server.stats()).toMatchObject({ active: 1, queued: 0, inflightBytes: base.inflightBytes });
      // maxQueued is 1, so the same frame is admitted again only because the slot came back, and its bytes count again once.
      const again = rawSession(server.socketPath);
      cleanups.push(() => { again.destroy(); });
      await again.send(hello);
      await again.send(queuedFrame(3, 60_000));
      await until(() => server.stats().queued === 1);
      expect(server.stats()).toMatchObject({ queued: 1, inflightBytes: base.inflightBytes + held });
      expect(again.frames.find(f => f.t === 'result')).toBeUndefined();
      expect(ran.filter(r => r.startsWith('getHealth'))).toEqual(['getHealth:running']);
    });
  }
});

describe('the owner in-flight byte cap', () => {
  test('a call whose frame would pass maxInflightBytes is refused with owner_busy inflight_bytes; bytes come back when a call settles', async () => {
    const { server, ran } = await blockingOwner({ permits: 4, maxInflightBytes: 1_000 });
    const raw = rawSession(server.socketPath);
    cleanups.push(() => { raw.destroy(); });
    const big = 'x'.repeat(600);
    await raw.send(hello);
    await raw.send(call(1, 'getHealth', [big]));
    for (let i = 0; i < 40 && server.stats().active !== 1; i++) await Bun.sleep(25);
    await raw.send(call(2, 'getHealth', [big]));
    const refused = errorOf(await raw.next(f => f.t === 'result' && f.id === 2));
    expect({ code: refused.code, reason: refused.reason }).toEqual({ code: 'owner_busy', reason: 'inflight_bytes' });
    expect(refused.detail).toContain('limit=1000');
    expect(ran.filter(r => r.startsWith('getHealth'))).toHaveLength(1);
    // A small call still fits beside the large one.
    await raw.send(call(3, 'getConfig', ['small']));
    expect((await raw.next(f => f.t === 'result' && f.id === 3))?.ok).toBe(true);
    // Once the large call settles its bytes are free, and the same large frame is admitted.
    await raw.send({ t: 'cancel', id: 1 });
    for (let i = 0; i < 40 && server.stats().active !== 0; i++) await Bun.sleep(25);
    await raw.send(call(4, 'getHealth', [big]));
    for (let i = 0; i < 40 && server.stats().active !== 1; i++) await Bun.sleep(25);
    expect(server.stats().active).toBe(1);
    expect(raw.frames.find(f => f.id === 4)).toBeUndefined();
  });
});

describe('the owner byte budget of a running call that is timed out or cancelled', () => {
  for (const ending of ['times out', 'is cancelled'] as const) {
    // Value: protects=a timed-out or cancelled running call keeps its bytes until its work settles; fails_when=bytes come back at the early reply; why_new=bytes were only checked after a cancel that ends the work at once; seam=none; no_claim=queued calls
    test(`a running call that ${ending} while its work ignores the abort keeps its bytes: owner_busy until the work settles, then admitted`, async () => {
      const { server, ran, release } = await gatedOwner({ permits: 4, maxInflightBytes: 1_000 });
      const raw = rawSession(server.socketPath);
      cleanups.push(() => { raw.destroy(); });
      const big = 'x'.repeat(600);
      await raw.send(hello);
      await raw.send(ending === 'times out' ? { ...call(1, 'getHealth', [big]), deadline_at: Date.now() + 300 } : call(1, 'getHealth', [big]));
      await until(() => server.stats().active === 1);
      expect(server.stats().active).toBe(1);
      const held = server.stats().inflightBytes;
      expect(held).toBeGreaterThan(600);
      if (ending === 'times out') {
        const ended = errorOf(await raw.next(f => f.t === 'result' && f.id === 1));
        // The owner started it, so its outcome is unknown (routes.ts ownerCallTimeout, stage `sent`).
        expect(ended.code).toBe('owner_unavailable');
        expect(ended.reason).toBe('outcome_unknown');
      } else {
        await raw.send({ t: 'cancel', id: 1 });
        await Bun.sleep(100);
        expect(raw.frames.find(f => f.id === 1)).toBeUndefined();
      }
      // The caller was answered or dropped, but the engine call still runs, so its permit and bytes are still held.
      expect(server.stats()).toMatchObject({ active: 1, inflightBytes: held });
      await raw.send(call(2, 'getHealth', [big]));
      const refused = errorOf(await raw.next(f => f.t === 'result' && f.id === 2));
      expect({ code: refused.code, reason: refused.reason }).toEqual({ code: 'owner_busy', reason: 'inflight_bytes' });
      expect(ran.filter(r => r.startsWith('getHealth'))).toHaveLength(1);
      // Once the delayed work settles its bytes are free and the same frame is admitted and answered.
      release();
      await until(() => server.stats().active === 0);
      expect(server.stats()).toMatchObject({ active: 0, inflightBytes: 0 });
      await raw.send(call(3, 'getHealth', [big]));
      const admitted = await raw.next(f => f.t === 'result' && f.id === 3);
      expect(admitted?.ok).toBe(true);
      expect(ran.filter(r => r.startsWith('getHealth'))).toHaveLength(2);
    });
  }
});

describe('the owner queue and byte limits are shared by every connection', () => {
  // Value: protects=the queue cap counts the waiting calls of all clients together, so two clients that are each under it cannot between them grow the owner's queue past it; fails_when=the cap is kept per connection; why_new=every cap test above uses one connection, where a per-connection count and a shared one agree; seam=the maxQueued option; no_claim=bytes
  test('two clients that each hold one waiting call fill a queue of 2: the next call is refused queue_full, and is admitted once the other client leaves', async () => {
    const { server, ran } = await blockingOwner({ permits: 1, maxQueued: 2 });
    const a = rawSession(server.socketPath);
    const b = rawSession(server.socketPath);
    cleanups.push(() => { a.destroy(); b.destroy(); });
    await a.send(hello);
    await a.send(call(1, 'getHealth', ['a-running']));
    await until(() => server.stats().active === 1);
    await a.send(call(2, 'getHealth', ['a-queued']));
    await b.send(hello);
    await b.send(call(3, 'getHealth', ['b-queued']));
    await until(() => server.stats().queued === 2);
    // Each client alone holds one waiting call, under the cap of 2; together they hold 2.
    expect(server.stats()).toMatchObject({ active: 1, queued: 2, connections: 2 });
    await b.send(call(4, 'getConfig', ['b-over']));
    const refused = errorOf(await b.next(f => f.t === 'result' && f.id === 4));
    expect({ code: refused.code, reason: refused.reason, retryable: refused.retryable }).toEqual({ code: 'owner_busy', reason: 'queue_full', retryable: true });
    expect(refused.detail).toContain('limit=2');
    expect(ran).not.toContain('getConfig:b-over');
    expect(server.stats().queued).toBe(2);
    // The other client leaving gives its running call's permit and its waiting call's slot back; the same call is then admitted.
    a.destroy();
    await until(() => server.stats().connections === 1 && server.stats().queued === 0);
    expect(server.stats()).toMatchObject({ active: 1, queued: 0, connections: 1 });
    await b.send(call(5, 'getConfig', ['b-retry']));
    await until(() => server.stats().queued === 1);
    expect(server.stats().queued).toBe(1);
    expect(b.frames.find(f => f.id === 5)).toBeUndefined();
  });

  // Value: protects=the in-flight byte budget counts the call frames of all clients together; fails_when=the budget is kept per connection; why_new=the byte cap test above sends both large frames on one connection; seam=the maxInflightBytes option; no_claim=queue slots
  test('two clients that each send one large frame go over a budget of 1000 bytes together: the second is refused inflight_bytes, and is admitted once the first client leaves', async () => {
    const { server, ran } = await blockingOwner({ permits: 4, maxInflightBytes: 1_000 });
    const a = rawSession(server.socketPath);
    const b = rawSession(server.socketPath);
    cleanups.push(() => { a.destroy(); b.destroy(); });
    const big = 'x'.repeat(600);
    await a.send(hello);
    await a.send(call(1, 'getHealth', [big]));
    await until(() => server.stats().active === 1);
    const held = server.stats().inflightBytes;
    // One such frame fits alone; two do not fit together.
    expect(held).toBeGreaterThan(600);
    expect(held * 2).toBeGreaterThan(1_000);
    await b.send(hello);
    await b.send(call(2, 'getHealth', [big]));
    const refused = errorOf(await b.next(f => f.t === 'result' && f.id === 2));
    expect({ code: refused.code, reason: refused.reason, retryable: refused.retryable }).toEqual({ code: 'owner_busy', reason: 'inflight_bytes', retryable: true });
    expect(refused.detail).toContain('limit=1000');
    expect(ran.filter(r => r.startsWith('getHealth'))).toHaveLength(1);
    expect(server.stats().inflightBytes).toBe(held);
    // A small call of the second client still fits beside the first client's large one.
    await b.send(call(3, 'getConfig', ['small']));
    expect((await b.next(f => f.t === 'result' && f.id === 3))?.ok).toBe(true);
    a.destroy();
    await until(() => server.stats().inflightBytes === 0);
    expect(server.stats()).toMatchObject({ active: 0, inflightBytes: 0 });
    await b.send(call(4, 'getHealth', [big]));
    await until(() => server.stats().active === 1);
    expect(server.stats()).toMatchObject({ active: 1, inflightBytes: held });
    expect(b.frames.find(f => f.id === 4)).toBeUndefined();
  });
});

describe('the owner connection cap', () => {
  test('a connection past maxConnections gets owner_busy connections and is closed; the client connect rejects with it', async () => {
    const { server } = await blockingOwner({ maxConnections: 1 });
    const first = rawSession(server.socketPath);
    cleanups.push(() => { first.destroy(); });
    await first.send(hello);
    expect(await first.next(f => f.t === 'hello')).not.toBeNull();
    const second = rawSession(server.socketPath);
    cleanups.push(() => { second.destroy(); });
    const refused = await second.next(f => f.t === 'refused');
    const error = errorOf(refused);
    expect({ code: error.code, reason: error.reason }).toEqual({ code: 'owner_busy', reason: 'connections' });
    expect(await second.closes()).toBe(true);
    const outcome = await connectOwner(server.socketPath).then(c => { c.close(); return null; }, e => e as OperationError);
    expect(outcome).toBeInstanceOf(OperationError);
    expect({ code: outcome?.code, reason: outcome?.reason }).toEqual({ code: 'owner_busy', reason: 'connections' });
    // The connection that was admitted still works.
    await first.send(call(1, 'getConfig', ['still']));
    expect((await first.next(f => f.t === 'result' && f.id === 1))?.ok).toBe(true);
  });

  // Value: protects=a peer that reads its refusal and never closes its own half cannot keep an owner descriptor open for good; fails_when=a refused socket waits on the peer to close; why_new=refused peers in the tests close themselves, never half-open; seam=none; no_claim=socket count
  test('a refused peer that keeps its half open is cut off after the drain period', async () => {
    const { server } = await blockingOwner({ maxConnections: 1 });
    const first = rawSession(server.socketPath);
    cleanups.push(() => { first.destroy(); });
    await first.send(hello);
    expect(await first.next(f => f.t === 'hello')).not.toBeNull();
    const peers = Array.from({ length: 3 }, () => {
      const socket = net.connect({ path: server.socketPath, allowHalfOpen: true });
      const state = { refused: false, closed: false };
      socket.on('error', () => {});
      socket.on('data', chunk => { if (String(chunk).includes('"refused"')) state.refused = true; });
      socket.on('close', () => { state.closed = true; });
      cleanups.push(() => { socket.destroy(); });
      return { socket, state };
    });
    for (let i = 0; i < 100 && !peers.every(p => p.state.refused); i++) await Bun.sleep(20);
    expect(peers.map(p => p.state.refused)).toEqual([true, true, true]);
    await Bun.sleep(OWNER_IPC_REFUSED_DRAIN_MS + 500);
    // A write to a socket the owner destroyed is answered with a reset; a socket the owner still holds takes it silently.
    for (const { socket } of peers) socket.write('x\n');
    for (let i = 0; i < 100 && !peers.every(p => p.state.closed); i++) await Bun.sleep(20);
    expect(peers.map(p => p.state.closed)).toEqual([true, true, true]);
  });

  // Value: protects=an owner under a flood of refused peers that never close holds at most OWNER_IPC_REFUSED_LIMIT of their sockets, and each for at most OWNER_IPC_REFUSED_DRAIN_MS; fails_when=the cap on held refusals is missing or off by one, or a held refusal outlives its drain; why_new=the test above opens three peers, so the limit itself is never reached; seam=none (the exported limit and the 1 s drain are the real constants); no_claim=how many refusals the owner can answer per second
  test('refused peers that never close are held only up to OWNER_IPC_REFUSED_LIMIT: the next is dropped at once with no frame, and every held one is cut off after the drain period', async () => {
    const { server } = await blockingOwner({ maxConnections: 1 });
    const first = rawSession(server.socketPath);
    cleanups.push(() => { first.destroy(); });
    await first.send(hello);
    expect(await first.next(f => f.t === 'hello')).not.toBeNull();
    const peer = () => {
      const socket = net.connect({ path: server.socketPath, allowHalfOpen: true });
      const state = { refused: false, ended: false, closed: false };
      socket.on('error', () => {});
      socket.on('data', chunk => { if (String(chunk).includes('"refused"')) state.refused = true; });
      socket.on('end', () => { state.ended = true; });
      socket.on('close', () => { state.closed = true; });
      cleanups.push(() => { socket.destroy(); });
      return { socket, state };
    };
    const held = Array.from({ length: OWNER_IPC_REFUSED_LIMIT }, peer);
    await until(() => held.every(p => p.state.refused));
    expect(held.filter(p => p.state.refused)).toHaveLength(OWNER_IPC_REFUSED_LIMIT);
    // One refusal past the limit: the owner closes its side with no refused frame, instead of holding another descriptor.
    const over = peer();
    await until(() => over.state.ended);
    expect(over.state).toMatchObject({ refused: false, ended: true });
    // A write to a socket the owner destroyed is answered with a reset; a socket the owner still holds takes it silently.
    over.socket.write('x\n');
    await until(() => over.state.closed);
    expect(over.state.closed).toBe(true);
    expect(held.some(p => p.state.closed)).toBe(false);
    // Each held refusal is destroyed after the drain period, and the freed slots hold refusals again.
    await Bun.sleep(OWNER_IPC_REFUSED_DRAIN_MS + 500);
    for (const { socket } of held) socket.write('x\n');
    await until(() => held.every(p => p.state.closed));
    expect(held.filter(p => p.state.closed)).toHaveLength(OWNER_IPC_REFUSED_LIMIT);
    const again = peer();
    await until(() => again.state.refused);
    expect(again.state.refused).toBe(true);
  });
});

describe('a peer refused for its hello version', () => {
  // Value: protects=a peer whose hello version is wrong and that never closes its own half neither holds a connection slot nor outlives the drain period; fails_when=the version refusal only half-closes the socket and leaves it counted among the owner's connections; why_new=the refusals tested above are connection-limit and peer-user refusals, never the version one; seam=none; no_claim=how many such peers the owner can answer per second
  test('holds no connection slot and is cut off after the drain period, so a right-version client still connects', async () => {
    const { server } = await blockingOwner({ maxConnections: 1 });
    const peers: Array<{ socket: net.Socket; state: { hello: boolean; closed: boolean } }> = [];
    // One after the other: each is admitted into the one slot, and its wrong version must give that slot back.
    for (let n = 0; n < 3; n++) {
      const socket = net.connect({ path: server.socketPath, allowHalfOpen: true });
      const state = { hello: false, closed: false };
      socket.on('error', () => {});
      socket.on('data', chunk => { if (String(chunk).includes('"hello"')) state.hello = true; });
      socket.on('close', () => { state.closed = true; });
      socket.write(`${JSON.stringify({ t: 'hello', version: OWNER_IPC_VERSION + 1 })}\n`);
      cleanups.push(() => { socket.destroy(); });
      peers.push({ socket, state });
      await until(() => state.hello);
    }
    expect(peers.map(p => p.state.hello)).toEqual([true, true, true]);
    // The one slot is free: a client of the right version is admitted while the wrong-version peers are still open.
    const ok = await connectOwner(server.socketPath).then(c => c, e => e as OperationError);
    expect(ok).not.toBeInstanceOf(Error);
    (ok as { close: () => void }).close();
    expect(peers.some(p => p.state.closed)).toBe(false);
    await Bun.sleep(OWNER_IPC_REFUSED_DRAIN_MS + 500);
    // A write to a socket the owner destroyed is answered with a reset; a socket the owner still holds takes it silently.
    for (const { socket } of peers) socket.write('x\n');
    await until(() => peers.every(p => p.state.closed));
    expect(peers.map(p => p.state.closed)).toEqual([true, true, true]);
  });
});

test('owner_busy is registered, retryable, with every reason the owner gives', () => {
  const rows = CODES as unknown as Record<string, { reasons?: readonly string[]; class?: string }>;
  expect(rows.owner_busy?.reasons).toEqual(['queue_full', 'inflight_bytes', 'connections']);
  expect(rows.owner_busy?.class).toBe('retryable');
});
