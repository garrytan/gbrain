/**
 * Owner socket peer identity (src/core/rust-engine/owner-ipc/): the owner reads each connecting process's OS uid from
 * the kernel and refuses any other user, and a client checks the socket's owner and mode before it connects and the
 * owner's uid after, refusing with `owner_ipc_peer_refused`.
 *
 * 1. Protects: a process of another OS user (or one whose uid cannot be read) never runs a call on the owner, and a
 *    client never sends a call to a socket another user made or one other users may open.
 * 2. Fails on: a server that serves every peer, a client that connects to a socket with group or other mode bits or
 *    another owner, or a client that never reads the owner's uid.
 * 3. Existing coverage: rust-owner-ipc.test.ts "owner socket file modes" checks the 0700 directory and 0600 socket the
 *    owner makes; nothing checks who is on the other end.
 * 4. Seam: the `peerCred` and `uid` options of `serveOwnerEngine` and `connectOwner` stand in for another user, since
 *    the test cannot run a second OS user. The platform reader runs for real where it exists (the last test).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { serveOwnerEngine, type OwnerServerOptions } from '../src/core/rust-engine/owner-ipc/server.ts';
import { connectOwner } from '../src/core/rust-engine/owner-ipc/client.ts';
import { OWNER_IPC_VERSION } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { decodeError, encodeValue, type Wire } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { peerCredSupport } from '../src/core/cli-socket/peer-cred.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { CODES } from '../src/core/error-registry.ts';
import { rawSession } from './helpers/owner-ipc-raw.ts';

const posix = process.platform !== 'win32' && process.getuid !== undefined;
const myUid = posix ? process.getuid!() : 0;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function owner(opts: OwnerServerOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-peer-'));
  const ran: string[] = [];
  const engine = {
    kind: 'pglite', capabilities: new Set<string>(),
    getConfig: async (key: unknown) => { ran.push(String(key)); return 'value'; },
  } as unknown as BrainEngine;
  const server = await serveOwnerEngine(engine, join(dir, 'owner.sock'), opts);
  if (!server) throw new Error('no socket');
  cleanups.push(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { server, ran };
}

const refusalOf = (error: unknown) => {
  expect(error).toBeInstanceOf(OperationError);
  const e = error as OperationError;
  return { code: e.code, reason: e.reason, retryable: e.retryable };
};

describe.skipIf(!posix)('the owner checks the peer uid', () => {
  for (const [label, read] of [['another uid', () => myUid + 1], ['an unreadable uid', () => null]] as const) {
    test(`a peer with ${label} gets owner_ipc_peer_refused peer_uid, its call never runs, and the socket closes`, async () => {
      const { server, ran } = await owner({ peerCred: { ok: true, read }, uid: () => myUid });
      const raw = rawSession(server.socketPath);
      cleanups.push(() => { raw.destroy(); });
      await raw.send({ t: 'hello', version: OWNER_IPC_VERSION });
      await raw.send({ t: 'call', id: 1, member: 'getConfig', args: encodeValue(['k']) });
      const refused = await raw.next(f => f.t === 'refused');
      const error = decodeError(refused?.error as Wire) as OperationError;
      expect({ code: error.code, reason: error.reason }).toEqual({ code: 'owner_ipc_peer_refused', reason: 'peer_uid' });
      expect(error.detail).toContain(`owner_uid=${myUid}`);
      expect(await raw.closes()).toBe(true);
      expect(raw.frames.some(f => f.t === 'hello' || f.t === 'result')).toBe(false);
      expect(ran).toEqual([]);
      const outcome = await connectOwner(server.socketPath).then(c => { c.close(); return null; }, e => e);
      expect(refusalOf(outcome)).toEqual({ code: 'owner_ipc_peer_refused', reason: 'peer_uid', retryable: false });
    });
  }

  test('a peer with the same uid is served', async () => {
    const { server, ran } = await owner({ peerCred: { ok: true, read: () => myUid }, uid: () => myUid });
    const connection = await connectOwner(server.socketPath);
    try {
      expect(await connection.request('call', 'getConfig', ['k'])).toBe('value');
      expect(ran).toEqual(['k']);
    } finally { connection.close(); }
  });
});

describe.skipIf(!posix)('the client checks the socket before it connects', () => {
  test('a socket other users may open is refused with socket_mode, and the owner never sees a connection', async () => {
    const { server } = await owner();
    chmodSync(dirname(server.socketPath), 0o755);
    chmodSync(server.socketPath, 0o666);
    const outcome = await connectOwner(server.socketPath).then(c => { c.close(); return null; }, e => e);
    expect(refusalOf(outcome)).toEqual({ code: 'owner_ipc_peer_refused', reason: 'socket_mode', retryable: false });
    expect((outcome as OperationError).detail).toContain('mode=0666');
    expect(server.stats().connections).toBe(0);
  });

  test('a socket with open mode bits inside a private directory is still used: no other user can reach it there', async () => {
    const { server } = await owner();
    chmodSync(dirname(server.socketPath), 0o700);
    chmodSync(server.socketPath, 0o755);
    const connection = await connectOwner(server.socketPath);
    try { expect(await connection.request('call', 'getConfig', ['k'])).toBe('value'); } finally { connection.close(); }
  });

  test('a socket another user owns is refused with socket_owner', async () => {
    const { server } = await owner();
    const outcome = await connectOwner(server.socketPath, { uid: () => myUid + 1 }).then(c => { c.close(); return null; }, e => e);
    expect(refusalOf(outcome)).toEqual({ code: 'owner_ipc_peer_refused', reason: 'socket_owner', retryable: false });
    expect(server.stats().connections).toBe(0);
  });

  test('an owner whose uid is another user is refused with peer_uid after the connect', async () => {
    const { server, ran } = await owner();
    const outcome = await connectOwner(server.socketPath, { peerCred: { ok: true, read: () => myUid + 1 } })
      .then(c => { c.close(); return null; }, e => e);
    expect(refusalOf(outcome)).toEqual({ code: 'owner_ipc_peer_refused', reason: 'peer_uid', retryable: false });
    expect(ran).toEqual([]);
  });

  test('a missing socket still fails with ENOENT, which the election retries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-peer-none-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const outcome = await connectOwner(join(dir, 'owner.sock')).then(c => { c.close(); return null; }, e => e as NodeJS.ErrnoException);
    expect(outcome?.code).toBe('ENOENT');
  });
});

test.skipIf(!posix || !peerCredSupport().ok)('with the platform reader, an owner and a client of the same user talk', async () => {
  const { server } = await owner();
  const connection = await connectOwner(server.socketPath);
  try { expect(await connection.request('call', 'getConfig', ['k'])).toBe('value'); } finally { connection.close(); }
});

test('owner_ipc_peer_refused is registered, not retryable, with every reason', () => {
  const rows = CODES as unknown as Record<string, { reasons?: readonly string[]; retryable?: boolean }>;
  expect(rows.owner_ipc_peer_refused?.reasons).toEqual(['peer_uid', 'socket_owner', 'socket_mode']);
  expect(rows.owner_ipc_peer_refused?.retryable).toBe(false);
});
