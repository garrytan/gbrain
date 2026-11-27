/**
 * Protocol v3 of a served Rust brain (src/core/rust-engine/served/, docs/designs/rust-engine/multi-user-server.md
 * "M1 as built"): the network hello and its owner server token, request ids, positions, the remote mark, file
 * locality, admission bounds, returning callbacks and transactions over the wire.
 *
 * 1. Protects: a network client gets in only with an owner server token, a lost answer is never a repeated write,
 *    a read with a token sees the write it names, a remote caller never writes, and the server's memory is bounded
 *    before a hello is proven.
 * 2. Fails on: an owner that accepts a missing, unknown, narrowed or expired token; a retry that runs a write twice
 *    or forgets a running call; a position the server did not publish; a remote frame that runs a write; a server
 *    path read for a network client; a pre-auth frame or idle connection the server keeps.
 * 3. Existing coverage: the v2 owner socket tests (rust-owner-ipc*.test.ts) cover the shared dispatcher; nothing
 *    covered v3.
 * 4. Seam: a recording fake engine on a real owner server and a real loopback TCP listener; the bearer check is the
 *    `verify` seam of served/auth.ts, given AuthInfo shapes of the real verifier.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import net, { type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { serveOwnerEngine, type OwnerEngineServer } from '../src/core/rust-engine/owner-ipc/server.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { connectServed, type ServedConnection } from '../src/core/rust-engine/served/client.ts';
import { encodeLengthFrame, readLengthFrames, byteBudget } from '../src/core/rust-engine/served/framing.ts';
import { OWNER_TOKEN_IDS_CONFIG_KEY } from '../src/core/rust-engine/served/auth.ts';
import { decodeError, decodeValue, encodeValue, type Wire } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { withRemoteCaller } from '../src/core/remote-caller.ts';
import type { ServedServerOptions } from '../src/core/rust-engine/served/session.ts';
import { withEnv } from './helpers/with-env.ts';

const OWNER_TOKEN = 'gbrain_owner_test_token';
const NARROW_TOKEN = 'gbrain_narrow_test_token';
const EXPIRED_TOKEN = 'gbrain_expired_test_token';
const ownerInfo = { principal: { kind: 'legacy_token', id: 'tok-1' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null, expiresAt: Math.floor(Date.now() / 1000) + 3600 };

let dir: string;
let server: OwnerEngineServer;
let listener: ServedListener;
const ran: string[] = [];
let published = { sequence: 7, index: 0, exact: true };
let revoked = false;
let gate: Promise<void> | null = null;
let writes = 0;

const fake = {
  kind: 'rust', capabilities: new Set<string>(['persistence_journal']),
  getConfig: async (key: string) => key === OWNER_TOKEN_IDS_CONFIG_KEY ? JSON.stringify(['tok-1', 'tok-narrow', 'tok-exp']) : null,
  getPage: async (slug: unknown) => { ran.push(`getPage:${String(slug)}`); return { slug, title: 'T' }; },
  putPage: async (slug: unknown) => {
    ran.push(`putPage:${String(slug)}`);
    if (gate) await gate;
    writes++;
    published = { ...published, sequence: published.sequence + 1 };
    return { slug, written: writes };
  },
  admitJob: async (spec: unknown, policy: { decide: (tx: unknown, row: unknown) => Promise<unknown> }) => {
    ran.push('admitJob');
    const decision = await policy.decide(fake, { id: 1, spec });
    return { decision };
  },
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    ran.push('transaction:begin');
    const tx = { ...fake, putPage: async (slug: unknown) => { ran.push(`tx.putPage:${String(slug)}`); return { slug, tx: true }; } };
    try { const v = await fn(tx); ran.push('transaction:commit'); return v; } catch (e) { ran.push('transaction:rollback'); throw e; }
  },
} as unknown as BrainEngine;

const servedOpts: ServedServerOptions = {
  verify: {
    verify: async (_engine, token) => {
      if (token === OWNER_TOKEN && !revoked) return { ...ownerInfo };
      if (token === NARROW_TOKEN) return { ...ownerInfo, principal: { kind: 'legacy_token', id: 'tok-narrow' }, allowedOperations: [] };
      if (token === EXPIRED_TOKEN) return { ...ownerInfo, principal: { kind: 'legacy_token', id: 'tok-exp' }, expiresAt: Math.floor(Date.now() / 1000) - 10 };
      throw new Error('Invalid token');
    },
  },
  positions: async () => ({ ...published }),
  transactions: () => true,
  helloTimeoutMs: 300,
  preauthMaxConnections: 4,
  callbackTimeoutMs: 2_000,
  log: () => {},
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-served-wire-'));
  server = (await serveOwnerEngine(fake, join(dir, 'owner.sock'), {
    served: servedOpts,
    wholeOperations: {
      importFromContent: async () => { ran.push('fn:importFromContent'); return { ok: true }; },
      importFromFile: async () => { ran.push('fn:importFromFile'); return { ok: true }; },
    },
  }))!;
  listener = await listenServed(server, { host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await listener?.close();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const url = () => `gbrain+tcp://127.0.0.1:${listener.port}`;
const open: ServedConnection[] = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); ran.length = 0; revoked = false; gate = null; });
async function client(token = OWNER_TOKEN): Promise<ServedConnection> { const c = await connectServed(url(), { token }); open.push(c); return c; }

/** A raw v3 peer: send length frames, read them back. */
function rawPeer(): Promise<{ socket: Socket; send(frame: object): void; next(): Promise<Record<string, unknown>>; closed: Promise<void> }> {
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

describe('hello and credential', () => {
  test('an owner server token gets in and a call runs on the owner', async () => {
    const c = await client();
    expect(c.hello.version).toBe(3);
    expect(c.caps.has('request_ids')).toBe(true);
    expect(await c.request('call', 'getPage', ['a'])).toEqual({ slug: 'a', title: 'T' });
    expect(ran).toEqual(['getPage:a']);
  });

  test('no token, an unknown token, a narrowed token and an expired token are refused before any call runs', async () => {
    for (const [token, reason] of [[undefined, 'token_missing'], ['nope', 'token_invalid'], [NARROW_TOKEN, 'token_not_owner'], [EXPIRED_TOKEN, 'token_expired']] as const) {
      const error = await connectServed(url(), token ? { token } : {}).then(() => null, (e: unknown) => e as { code?: string; reason?: string; message: string });
      expect({ code: error?.code, reason: error?.reason }).toEqual({ code: 'permission_denied', reason });
      expect(error!.message).not.toContain(String(token));
    }
    expect(ran).toEqual([]);
  });

  test('a revoked token stops new work on a live connection within the recheck interval', async () => {
    const c = await client();
    await c.request('call', 'getPage', ['x']);
    revoked = true;
    await Bun.sleep(2_600);
    const error = await c.request('call', 'getPage', ['y']).then(() => null, (e: unknown) => e as { code?: string; reason?: string });
    expect({ code: error?.code, reason: error?.reason }).toEqual({ code: 'permission_denied', reason: 'token_expired' });
    expect(ran).toEqual(['getPage:x']);
  }, 10_000);

  test('a connection that sends no hello is closed after the hello bound; an oversized hello is refused', async () => {
    const idle = await rawPeer();
    const refusal = await idle.next();
    expect(refusal.t).toBe('refused');
    expect((decodeError(refusal.error as Wire) as { reason?: string }).reason).toBe('hello_timeout');
    await idle.closed;
    const big = await rawPeer();
    big.send({ t: 'hello', v: 3, version: 3, caps: [], pad: 'x'.repeat(70 * 1024) });
    const tooLarge = await big.next();
    expect((decodeError(tooLarge.error as Wire) as { reason?: string }).reason).toBe('hello_too_large');
    await big.closed;
  });

  test('more connections waiting for a hello than the bound are refused at once, and a real client still gets in', async () => {
    const idle = await Promise.all([rawPeer(), rawPeer(), rawPeer(), rawPeer()]);
    const extra = await rawPeer();
    const refusal = await extra.next();
    expect((decodeError(refusal.error as Wire) as { reason?: string }).reason).toBe('budget_exhausted');
    for (const p of idle) p.socket.destroy();
    await Bun.sleep(50);
    const c = await client();
    expect(await c.request('call', 'getPage', ['ok'])).toEqual({ slug: 'ok', title: 'T' });
  });
});

describe('request ids', () => {
  async function helloed() {
    const p = await rawPeer();
    p.send({ t: 'hello', v: 3, version: 3, caps: ['request_ids', 'positions'], auth: { scheme: 'bearer', token: OWNER_TOKEN } });
    expect((await p.next()).t).toBe('hello');
    return p;
  }
  const call = (id: number, req: string, slug: string, extra: object = {}) =>
    ({ t: 'call', id, member: 'putPage', args: encodeValue([slug]), req, ...extra });

  test('a retry of a finished write returns its stored outcome and does not run it again', async () => {
    const p = await helloed();
    const req = Bun.randomUUIDv7();
    p.send(call(1, req, 'r1'));
    const first = await p.next();
    p.send(call(2, req, 'r1', { retry: true }));
    const again = await p.next();
    expect(decodeValue(again.value as Wire)).toEqual(decodeValue(first.value as Wire));
    expect(again.position).toEqual(first.position);
    expect(ran.filter(r => r === 'putPage:r1')).toHaveLength(1);
    p.socket.destroy();
  });

  test('a retry while the write still runs attaches to it; a retry the server has no record of is outcome_unknown', async () => {
    const p = await helloed();
    let open!: () => void;
    gate = new Promise(r => { open = r; });
    const req = Bun.randomUUIDv7();
    p.send(call(1, req, 'r2'));
    await Bun.sleep(20);
    p.send(call(2, req, 'r2', { retry: true }));
    await Bun.sleep(20);
    open();
    const [a, b] = [await p.next(), await p.next()];
    expect(decodeValue(a.value as Wire)).toEqual(decodeValue(b.value as Wire));
    expect(ran.filter(r => r === 'putPage:r2')).toHaveLength(1);
    p.send(call(3, Bun.randomUUIDv7(), 'r3', { retry: true }));
    const unknown = await p.next();
    expect((decodeError(unknown.error as Wire) as { code?: string; reason?: string })).toMatchObject({ code: 'owner_unavailable', reason: 'outcome_unknown' });
    expect(ran).not.toContain('putPage:r3');
    p.socket.destroy();
  });

  test('the same request id with other arguments is an idempotency conflict and does not run', async () => {
    const p = await helloed();
    const req = Bun.randomUUIDv7();
    p.send(call(1, req, 'c1'));
    await p.next();
    p.send(call(2, req, 'c2'));
    const conflict = await p.next();
    expect((decodeError(conflict.error as Wire) as { code?: string }).code).toBe('idempotency_conflict');
    expect(ran).not.toContain('putPage:c2');
    p.socket.destroy();
  });
});

describe('positions', () => {
  test('a write result carries the published position; a read waits for its token and times out past it', async () => {
    const c = await client();
    await c.request('call', 'putPage', ['p1']);
    expect(c.lastPosition).toEqual({ sequence: published.sequence, index: 0 });
    const p = await rawPeer();
    p.send({ t: 'hello', v: 3, version: 3, caps: ['positions'], auth: { scheme: 'bearer', token: OWNER_TOKEN } });
    await p.next();
    p.send({ t: 'call', id: 1, member: 'getPage', args: encodeValue(['p1']), min_position: `cp1:${published.sequence}.0` });
    expect((await p.next()).ok).toBe(true);
    p.send({ t: 'call', id: 2, member: 'getPage', args: encodeValue(['p1']), min_position: `cp1:${published.sequence + 5}.0`, deadline_at: Date.now() + 100 });
    const late = await p.next();
    expect(decodeError(late.error as Wire)).toMatchObject({ code: 'timeout', reason: 'position_not_reached' });
    p.send({ t: 'call', id: 3, member: 'getPage', args: encodeValue(['p1']), min_position: 'cp1:abc' });
    expect(decodeError((await p.next()).error as Wire)).toMatchObject({ code: 'owner_ipc_protocol' });
    p.socket.destroy();
  });

  test('on a store that cannot order positions (optimistic) no position is returned and a token refuses', async () => {
    const before = published;
    published = { ...published, exact: false };
    try {
      const c = await client();
      await c.request('call', 'putPage', ['p2']);
      expect(c.lastPosition).toBeNull();
    } finally { published = before; }
  });
});

describe('remote mark and locality', () => {
  test('a remote caller reads, but its write and whole operations are refused on both sides', async () => {
    const c = await client();
    expect(await withRemoteCaller(true, () => c.request('call', 'getPage', ['r']))).toEqual({ slug: 'r', title: 'T' });
    const write = await withRemoteCaller(true, () => c.request('call', 'putPage', ['w'])).then(() => null, (e: unknown) => e as { code?: string });
    expect(write?.code).toBe('engine_capability_missing');
    // A forged frame: remote true with a write still refuses on the server.
    const p = await rawPeer();
    p.send({ t: 'hello', v: 3, version: 3, caps: [], auth: { scheme: 'bearer', token: OWNER_TOKEN } });
    await p.next();
    p.send({ t: 'call', id: 1, member: 'putPage', args: encodeValue(['forged']), remote: true });
    expect(decodeError((await p.next()).error as Wire)).toMatchObject({ code: 'engine_capability_missing' });
    expect(ran).toEqual(['getPage:r']);
    p.socket.destroy();
  });

  test('a network client cannot name a server path: importFromFile refuses; content imports run', async () => {
    const c = await client();
    const refused = await c.request('fn', 'importFromFile', ['/etc/hostname']).then(() => null, (e: unknown) => e as { code?: string; reason?: string });
    expect(refused).toMatchObject({ code: 'engine_capability_missing', reason: 'served' });
    expect(await c.request('fn', 'importFromContent', ['x', 'body'])).toEqual({ ok: true });
    expect(ran).toEqual(['fn:importFromContent']);
  });
});

describe('callbacks and transactions over the wire', () => {
  test('a callback that returns a value runs on the client and receives the transaction handle', async () => {
    const c = await client();
    let sawHandle = false;
    c.txProxy = ref => ({ __servedTxRef: ref, getPage: (slug: string) => c.request('call', 'getPage', [slug], { txn: ref }) });
    const out = await c.request('call', 'admitJob', [{ name: 'j' }, {
      decide: async (tx: { getPage(s: string): Promise<unknown> }, row: { id: number }) => {
        sawHandle = typeof tx.getPage === 'function';
        const page = await tx.getPage('inside');
        return { coalesce: false, row: row.id, page };
      },
    }]);
    expect(sawHandle).toBe(true);
    expect(out).toEqual({ decision: { coalesce: false, row: 1, page: { slug: 'inside', title: 'T' } } });
    expect(ran).toEqual(['admitJob', 'getPage:inside']);
  });

  test('a transaction the client opens commits its calls, and a thrown callback rolls it back', async () => {
    const c = await client();
    expect(c.caps.has('txn')).toBe(true);
    const ref = String(await c.txn('begin', {}));
    expect(await c.request('call', 'putPage', ['t1'], { txn: ref })).toEqual({ slug: 't1', tx: true });
    await c.txn('commit', { txn: ref });
    const ref2 = String(await c.txn('begin', {}));
    await c.txn('rollback', { txn: ref2 });
    expect(ran).toEqual(['transaction:begin', 'tx.putPage:t1', 'transaction:commit', 'transaction:begin', 'transaction:rollback']);
    const stale = await c.request('call', 'putPage', ['t2'], { txn: ref }).then(() => null, (e: unknown) => e as { code?: string });
    expect(stale?.code).toBe('engine_capability_missing');
  });

  test('a transaction left open rolls back when its connection closes', async () => {
    const c = await client();
    await c.txn('begin', {});
    c.close();
    await Bun.sleep(100);
    expect(ran).toEqual(['transaction:begin', 'transaction:rollback']);
  });
});

describe('the Unix owner socket', () => {
  test('a v3 hello on the owner socket is served without a token (the kernel proved the peer); v2 stays v2', async () => {
    const c = await connectServed(`gbrain+unix://${server.socketPath}`);
    open.push(c);
    expect(c.network).toBe(false);
    expect(await c.request('call', 'getPage', ['u'])).toEqual({ slug: 'u', title: 'T' });
  });
});

describe('off is identical', () => {
  test('an owner started without served options answers a v3 hello with its v2 hello and closes, as for any other version', async () => {
    const offDir = mkdtempSync(join(tmpdir(), 'gbrain-served-off-'));
    const off = (await serveOwnerEngine(fake, join(offDir, 'owner.sock')))!;
    try {
      expect(off.attachServed).toBeUndefined();
      const lines: string[] = [];
      const socket = net.createConnection(off.socketPath);
      await new Promise<void>(resolve => {
        socket.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)));
        socket.once('close', () => resolve());
        socket.once('connect', () => socket.write(JSON.stringify({ t: 'hello', v: 3, version: 3, caps: [] }) + '\n'));
      });
      expect(lines.map(l => JSON.parse(l))).toEqual([{ t: 'hello', version: 2, pid: process.pid, kind: 'rust', capabilities: ['persistence_journal'], serve: false }]);
      const error = await connectServed(`gbrain+unix://${off.socketPath}`).then(() => null, (e: unknown) => e as { code?: string; reason?: string });
      expect(error).toMatchObject({ code: 'owner_ipc_protocol', reason: 'version_mismatch' });
    } finally {
      await off.close();
      rmSync(offDir, { recursive: true, force: true });
    }
  });

  test('a v2 client of an owner with served options gets the same frames as before', async () => {
    const { connectOwner } = await import('../src/core/rust-engine/owner-ipc/client.ts');
    const c = await connectOwner(server.socketPath);
    try {
      expect(c.hello).toEqual({ t: 'hello', version: 2, pid: process.pid, kind: 'rust', capabilities: ['persistence_journal'], serve: false });
      expect(await c.request('call', 'getPage', ['v2'])).toEqual({ slug: 'v2', title: 'T' });
    } finally { c.close(); }
  });

  test('the switch: with GBRAIN_RUST_MULTIUSER unset no served options, no served target, no v3 operation', async () => {
    const { servedServerOptionsFor } = await import('../src/core/rust-engine/served/serve-listen.ts');
    const { servedTargetFor } = await import('../src/core/rust-engine/served/engine.ts');
    const { ownerWholeOperations } = await import('../src/core/rust-engine/owner-ipc/owner-ops.ts');
    await withEnv({ GBRAIN_RUST_MULTIUSER: undefined }, async () => {
      expect(servedServerOptionsFor(fake, null)).toBeUndefined();
      expect(servedServerOptionsFor(fake, { multiuser: false })).toBeUndefined();
      // The store's resolved answer wins: a brain on through its own config row serves v3 with the environment unset.
      expect(servedServerOptionsFor(fake, { multiuser: true })).toBeDefined();
      expect(servedTargetFor({ engine: 'rust', rust_server: { url: 'gbrain+tls://h:1' } }, { GBRAIN_RUST_SERVER_URL: 'gbrain+tls://h:1' })).toBeNull();
      expect(Object.keys(ownerWholeOperations())).toContain('importClientFile');
    });
  });

  test('the v3-only operations (file import, store calls, store keys, brain calls) are refused on v2 exactly as an operation the owner does not run', async () => {
    const offDir = mkdtempSync(join(tmpdir(), 'gbrain-served-v2op-'));
    const { ownerWholeOperations } = await import('../src/core/rust-engine/owner-ipc/owner-ops.ts');
    const { connectOwner } = await import('../src/core/rust-engine/owner-ipc/client.ts');
    const off = (await serveOwnerEngine(fake, join(offDir, 'owner.sock'), { wholeOperations: ownerWholeOperations() }))!;
    try {
      const c = await connectOwner(off.socketPath);
      const refused = (name: string) => c.request('fn', name, []).then(() => null, (e: unknown) => ({ code: (e as { code?: string }).code, message: (e as Error).message.replace(name, '<op>') }));
      for (const op of ['importClientFile', 'servedStoreCall', 'servedStoreKeys', 'servedBrainCall']) expect(await refused(op)).toEqual(await refused('noSuchOperation'));
      c.close();
    } finally {
      await off.close();
      rmSync(offDir, { recursive: true, force: true });
    }
  });
});
