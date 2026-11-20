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
import type { BrainEngine } from '../src/core/engine.ts';
import { serveOwnerEngine, type OwnerServerOptions } from '../src/core/rust-engine/owner-ipc/server.ts';
import { connectOwner } from '../src/core/rust-engine/owner-ipc/client.ts';
import { OWNER_IPC_VERSION } from '../src/core/rust-engine/owner-ipc/protocol.ts';
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
});

test('owner_busy is registered, retryable, with every reason the owner gives', () => {
  const rows = CODES as unknown as Record<string, { reasons?: readonly string[]; class?: string }>;
  expect(rows.owner_busy?.reasons).toEqual(['queue_full', 'inflight_bytes', 'connections']);
  expect(rows.owner_busy?.class).toBe('retryable');
});
