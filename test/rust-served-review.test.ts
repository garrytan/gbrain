/**
 * Findings of the second-model review of protocol v3 (served/), each pinned by a test written before its fix.
 *
 * 1. Protects: the credential gate on every frame that does work, request-id records that survive a lost connection
 *    and never strand a retry, replay bound to the caller's access, transaction calls held to the dispatcher's member
 *    and access rules, shutdown with idle clients, and client-file imports that pass only data.
 * 2. Fails on: a frame run while a hello is still being verified; a commit after revocation; outcome_unknown for a
 *    write still running; a cached read replayed to a narrower caller; a retry that hangs after a failed position
 *    read; unbounded retry waiters; a transaction call naming a lifecycle member; a transaction begun after its
 *    connection closed; a listener close that waits for idle clients; internal options or an unnormalised path in a
 *    client-file import; a FIFO or an oversized file read in full; the listen variable acting with the switch off.
 * 3. Existing coverage: rust-served-wire.test.ts covers the happy paths and the first credential, retry and position
 *    rules; it did not reach these cases.
 * 4. Seam: a recording fake engine on a real owner server and a loopback listener, as rust-served-wire.test.ts; the
 *    client-file import takes an injected importer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import net, { type Socket } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { serveOwnerEngine, type OwnerEngineServer } from '../src/core/rust-engine/owner-ipc/server.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { connectServed } from '../src/core/rust-engine/served/client.ts';
import { encodeLengthFrame, readLengthFrames, byteBudget } from '../src/core/rust-engine/served/framing.ts';
import { OWNER_TOKEN_IDS_CONFIG_KEY } from '../src/core/rust-engine/served/auth.ts';
import { decodeError, decodeValue, encodeValue, type Wire } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { callerAccessRecord } from '../src/core/search/private-visibility.ts';
import { importClientFile, readClientFile } from '../src/core/rust-engine/served/client-files.ts';
import { rustListenRequested } from '../src/core/rust-engine/served/serve-listen.ts';
import type { ServedServerOptions } from '../src/core/rust-engine/served/session.ts';

const OWNER_TOKEN = 'gbrain_review_owner_token';
const SLOW_TOKEN = 'gbrain_review_slow_token';
const ownerInfo = { principal: { kind: 'legacy_token', id: 'tok-1' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null };

let dir: string;
let server: OwnerEngineServer;
let listener: ServedListener;
const ran: string[] = [];
let revoked = false;
let gate: Promise<void> | null = null;
let beginGate: Promise<void> | null = null;
let positionsFail = 0;
let hang = false;

const fake = {
  kind: 'rust', capabilities: new Set<string>(['persistence_journal']),
  getConfig: async (key: string) => key === OWNER_TOKEN_IDS_CONFIG_KEY ? JSON.stringify(['tok-1']) : null,
  getPage: async (slug: unknown) => { ran.push(`getPage:${String(slug)}`); return { slug }; },
  putPage: async (slug: unknown) => { ran.push(`putPage:${String(slug)}`); if (gate) await gate; return { slug }; },
  disconnect: async () => { ran.push('disconnect'); },
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    if (beginGate) await beginGate;
    ran.push('transaction:begin');
    const tx = {
      ...fake,
      putPage: async (slug: unknown) => { ran.push(`tx.putPage:${String(slug)}`); return { slug }; },
      getConfig: async () => JSON.stringify(callerAccessRecord()?.identity ?? null),
      disconnect: async () => { ran.push('tx.disconnect'); },
    };
    try { const v = await fn(tx); ran.push('transaction:commit'); return v; } catch (e) { ran.push('transaction:rollback'); throw e; }
  },
} as unknown as BrainEngine;

const servedOpts: ServedServerOptions = {
  verify: {
    verify: async (_engine, token) => {
      if (hang) return new Promise(() => {});
      if (token === SLOW_TOKEN) { await Bun.sleep(300); return { ...ownerInfo }; }
      if (token === OWNER_TOKEN && !revoked) return { ...ownerInfo };
      throw new Error('Invalid token');
    },
  },
  positions: async () => { if (positionsFail > 0) { positionsFail--; throw new Error('position read failed'); } return { sequence: 5, index: 0, exact: true }; },
  transactions: () => true,
  helloTimeoutMs: 2_000,
  recheckHungMs: 1_000,
  log: () => {},
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-served-review-'));
  server = (await serveOwnerEngine(fake, join(dir, 'owner.sock'), { served: servedOpts }))!;
  listener = await listenServed(server, { host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await listener?.close();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => { hang = false; ran.length = 0; revoked = false; gate = null; beginGate = null; positionsFail = 0; });

type Peer = { socket: Socket; send(frame: object): void; next(): Promise<Record<string, unknown>>; closed: Promise<void> };
function rawPeer(): Promise<Peer> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port: listener.port }, () => {
      const queue: Record<string, unknown>[] = [];
      const waiters: Array<(f: Record<string, unknown>) => void> = [];
      readLengthFrames(socket, { maxFrameBytes: () => 1 << 26, budget: byteBudget(1 << 30), onFrame: f => { const w = waiters.shift(); if (w) w(f); else queue.push(f); }, onBad: () => {} });
      const closed = new Promise<void>(r => socket.once('close', () => r()));
      resolve({ socket, send: f => socket.write(encodeLengthFrame(f)!), next: () => queue.length ? Promise.resolve(queue.shift()!) : new Promise(r => waiters.push(r)), closed });
    });
    socket.on('error', () => {});
  });
}
async function helloed(caps = ['request_ids', 'positions', 'txn']): Promise<Peer> {
  const p = await rawPeer();
  p.send({ t: 'hello', v: 3, version: 3, caps, auth: { scheme: 'bearer', token: OWNER_TOKEN } });
  expect((await p.next()).t).toBe('hello');
  return p;
}
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, Bun.sleep(ms).then(() => 'timed out' as const)]);
const errorOf = (frame: Record<string, unknown>) => decodeError(frame.error as Wire) as { code?: string; reason?: string };

describe('G1: frames before the hello is answered', () => {
  test('a frame sent while the token is still being verified closes the connection and never runs', async () => {
    const p = await rawPeer();
    p.send({ t: 'hello', v: 3, version: 3, caps: [], auth: { scheme: 'bearer', token: SLOW_TOKEN } });
    p.send({ t: 'call', id: 1, member: 'putPage', args: encodeValue(['early']) });
    const first = await p.next();
    expect(first.t).toBe('refused');
    expect(errorOf(first)).toMatchObject({ code: 'owner_ipc_protocol', reason: 'frame_malformed' });
    await p.closed;
    await Bun.sleep(350);
    expect(ran).toEqual([]);
  });
});

describe('G2: transaction frames and callbacks pass the credential gate', () => {
  test('after revocation a transaction cannot commit: it rolls back and the commit is refused', async () => {
    const p = await helloed();
    p.send({ t: 'txn', id: 1, op: 'begin' });
    const ref = decodeValue((await p.next()).value as Wire) as string;
    revoked = true;
    await Bun.sleep(2_600);
    p.send({ t: 'txn', id: 2, op: 'commit', txn: ref });
    const out = await p.next();
    expect(out.ok).toBe(false);
    expect(errorOf(out).code).toBe('permission_denied');
    await Bun.sleep(50);
    expect(ran).toEqual(['transaction:begin', 'transaction:rollback']);
    p.socket.destroy();
  }, 10_000);
});

describe('G2: a recheck that never answers', () => {
  test('once a token recheck has hung past its bound, new calls refuse; until then they run', async () => {
    const p = await helloed();
    hang = true;
    p.send({ t: 'call', id: 1, member: 'getPage', args: encodeValue(['before']) });
    expect((await p.next()).ok).toBe(true);
    await Bun.sleep(2_000 + 1_300);
    p.send({ t: 'call', id: 2, member: 'getPage', args: encodeValue(['after']) });
    const out = await p.next();
    expect(errorOf(out)).toMatchObject({ code: 'permission_denied', reason: 'token_expired' });
    expect(ran).toEqual(['getPage:before']);
    p.socket.destroy();
  }, 10_000);
});

describe('G3: a lost connection keeps the record of a write that started', () => {
  test('the retry on a new connection attaches to the running write and gets its outcome', async () => {
    let open!: () => void;
    gate = new Promise(r => { open = r; });
    const req = Bun.randomUUIDv7();
    const a = await helloed();
    a.send({ t: 'call', id: 1, member: 'putPage', args: encodeValue(['g3']), req });
    await Bun.sleep(30);
    a.socket.destroy();
    await a.closed;
    const b = await helloed();
    b.send({ t: 'call', id: 1, member: 'putPage', args: encodeValue(['g3']), req, retry: true });
    await Bun.sleep(30);
    open();
    const out = await b.next();
    expect(out.ok).toBe(true);
    expect(decodeValue(out.value as Wire)).toEqual({ slug: 'g3' });
    expect(ran.filter(r => r === 'putPage:g3')).toHaveLength(1);
    b.socket.destroy();
  });
});

describe('G4: replay is bound to the caller access record', () => {
  test('the same request id with another access record is a conflict, not a replay', async () => {
    const p = await helloed();
    const req = Bun.randomUUIDv7();
    p.send({ t: 'call', id: 1, member: 'getPage', args: encodeValue(['g4']), req });
    expect((await p.next()).ok).toBe(true);
    p.send({ t: 'call', id: 2, member: 'getPage', args: encodeValue(['g4']), req, retry: true, access: encodeValue({ identity: ['member:alice-example'] }) });
    const out = await p.next();
    expect(errorOf(out).code).toBe('idempotency_conflict');
    p.socket.destroy();
  });
});

describe('G5: a failed position read does not strand the request', () => {
  test('after the position read fails, a retry of the same read runs instead of waiting forever', async () => {
    const p = await helloed();
    const req = Bun.randomUUIDv7();
    positionsFail = 1;
    p.send({ t: 'call', id: 1, member: 'getPage', args: encodeValue(['g5']), req, min_position: 'cp1:1.0' });
    expect((await p.next()).ok).toBe(false);
    p.send({ t: 'call', id: 2, member: 'getPage', args: encodeValue(['g5']), req, retry: true, min_position: 'cp1:1.0' });
    const out = await withTimeout(p.next(), 1_000);
    expect(out).not.toBe('timed out');
    expect((out as Record<string, unknown>).ok).toBe(true);
    p.socket.destroy();
  });
});

describe('G6: retry waiters are bounded', () => {
  test('past eight waiters on one running request the next retry is refused owner_busy', async () => {
    let open!: () => void;
    gate = new Promise(r => { open = r; });
    const req = Bun.randomUUIDv7();
    const p = await helloed();
    p.send({ t: 'call', id: 1, member: 'putPage', args: encodeValue(['g6']), req });
    await Bun.sleep(20);
    for (let i = 2; i <= 10; i++) p.send({ t: 'call', id: i, member: 'putPage', args: encodeValue(['g6']), req, retry: true });
    const busy = await withTimeout(p.next(), 500);
    expect(busy).not.toBe('timed out');
    expect(errorOf(busy as Record<string, unknown>).code).toBe('owner_busy');
    open();
    p.socket.destroy();
  });
});

describe('G8: transaction calls follow the dispatcher rules', () => {
  test('a lifecycle or private member on a transaction handle refuses and never runs', async () => {
    const p = await helloed();
    p.send({ t: 'txn', id: 1, op: 'begin' });
    const ref = decodeValue((await p.next()).value as Wire) as string;
    for (const [id, member] of [[2, 'disconnect'], [3, '__proto__'], [4, 'constructor']] as const) {
      p.send({ t: 'call', id, member, args: encodeValue([]), txn: ref });
      const out = await p.next();
      expect({ member, ok: out.ok, code: errorOf(out).code }).toEqual({ member, ok: false, code: 'engine_capability_missing' });
    }
    expect(ran).not.toContain('tx.disconnect');
    expect(ran).not.toContain('disconnect');
    p.send({ t: 'txn', id: 5, op: 'rollback', txn: ref });
    await p.next();
    p.socket.destroy();
  });

  test('a transaction call runs under the frame access record, as a dispatched call does', async () => {
    const p = await helloed();
    p.send({ t: 'txn', id: 1, op: 'begin' });
    const ref = decodeValue((await p.next()).value as Wire) as string;
    p.send({ t: 'call', id: 2, member: 'getConfig', args: encodeValue(['x']), txn: ref, access: encodeValue({ identity: ['member:alice-example'] }) });
    const out = await p.next();
    expect(decodeValue(out.value as Wire)).toBe(JSON.stringify(['member:alice-example']));
    p.send({ t: 'txn', id: 3, op: 'rollback', txn: ref });
    await p.next();
    p.socket.destroy();
  });
});

describe('G9: a begin that outlives its connection', () => {
  test('a transaction that begins after its connection closed rolls back at once', async () => {
    let open!: () => void;
    beginGate = new Promise(r => { open = r; });
    const p = await helloed();
    p.send({ t: 'txn', id: 1, op: 'begin' });
    await Bun.sleep(20);
    p.socket.destroy();
    await p.closed;
    await Bun.sleep(20);
    open();
    await Bun.sleep(50);
    expect(ran).toEqual(['transaction:begin', 'transaction:rollback']);
  });
});

describe('G10: shutdown with an idle client', () => {
  test('closing a listener does not wait for an idle connected client', async () => {
    const second = await listenServed(server, { host: '127.0.0.1', port: 0 });
    const c = await connectServed(`gbrain+tcp://127.0.0.1:${second.port}`, { token: OWNER_TOKEN });
    const started = Date.now();
    const closed = await withTimeout(second.close(), 1_500);
    c.close();
    expect(closed).not.toBe('timed out');
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

describe('G11/G12: client-file imports', () => {
  test('only data options pass, and the importer sees one normalised relative path', async () => {
    const seen: Array<{ path: string; rel: string; opts: Record<string, unknown> }> = [];
    const importer = async (_e: unknown, path: string, rel: string, opts: Record<string, unknown>) => { seen.push({ path, rel, opts }); return { status: 'imported' }; };
    await importClientFile(fake, 'importFromFile', '/client/a/./b.md', 'a/./b.md', { symlink: false, bytes: Buffer.from('# hi\n') },
      { noEmbed: true, sourceId: 'default', coordinated: true, prepare: 'x', boundedChunkWrites: true, history: { reason: 'x' } }, { importFromFile: importer });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.rel).toBe('a/b.md');
    expect(seen[0]!.path.endsWith('/a/b.md')).toBe(true);
    expect(seen[0]!.opts).toEqual({ noEmbed: true, sourceId: 'default' });
  });

  test('the server refuses bytes over the import size limit before writing them', async () => {
    const importer = async () => { throw new Error('should not run'); };
    const big = Buffer.alloc(30 * 1024 * 1024, 0x61);
    const error = await importClientFile(fake, 'importImageFile', '/client/x.png', 'x.png', { symlink: false, bytes: big }, {}, { importImageFile: importer })
      .then(() => null, (e: unknown) => e as { code?: string });
    expect(error?.code).toBe('engine_capability_missing');
  });

  test('the client refuses a FIFO without blocking, and does not read a file over the size limit', async () => {
    const d = mkdtempSync(join(tmpdir(), 'gbrain-served-fifo-'));
    try {
      execFileSync('mkfifo', [join(d, 'pipe.md')]);
      expect(() => readClientFile(join(d, 'pipe.md'), 'pipe.md')).toThrow();
      writeFileSync(join(d, 'big.png'), Buffer.alloc(21 * 1024 * 1024));
      const payload = readClientFile(join(d, 'big.png'), 'big.png', 'importImageFile');
      expect(payload).toEqual({ symlink: false, oversized: 21 * 1024 * 1024 });
      // The server answers the importer's own size skip for it.
      const answer = await importClientFile(fake, 'importImageFile', join(d, 'big.png'), 'big.png', payload, {});
      expect(answer).toMatchObject({ status: 'skipped', chunks: 0 });
      expect((answer as { error: string }).error).toContain('Image too large (22020096 bytes');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('the client image limit equals the importer\'s', async () => {
    const { MAX_IMAGE_BYTES } = await import('../src/core/import-file.ts');
    const { CLIENT_IMAGE_MAX_BYTES } = await import('../src/core/rust-engine/served/client-files.ts');
    expect(CLIENT_IMAGE_MAX_BYTES).toBe(MAX_IMAGE_BYTES);
  });
});

describe('G13: the listen variable with the switch off', () => {
  test('GBRAIN_RUST_SERVER_LISTEN asks for a listener only while multi-user Rust is on', () => {
    expect(rustListenRequested([], { GBRAIN_RUST_SERVER_LISTEN: '127.0.0.1:0' })).toBe(false);
    expect(rustListenRequested([], { GBRAIN_RUST_SERVER_LISTEN: '127.0.0.1:0', GBRAIN_RUST_MULTIUSER: '1' })).toBe(true);
  });
});
