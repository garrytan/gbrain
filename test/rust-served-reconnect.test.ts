/**
 * How a protocol v3 client comes back after its connection drops (src/core/rust-engine/served/client.ts; follow-up
 * L3-F2 of the second-model review, finding G7).
 *
 * 1. Protects: a call the server refused `owner_busy` (so it never ran) is sent again fresh after a reconnect, not as a
 *    retry the server cannot answer; a connection that dropped while idle reconnects on the next call; a reconnect
 *    that cannot reach the server ends with `owner_unavailable` `not_sent`; and a write that may have run is never run
 *    twice (its resend attaches to the running call by its request id).
 * 2. Fails on: `outcome_unknown` for a busy-refused write after a drop; the next call after an idle drop failing with
 *    "arguments are larger than" instead of reconnecting; a write run twice across a reconnect.
 * 3. Existing coverage: rust-served-review.test.ts G3 covers the server keeping a started write's record; nothing
 *    drove the client through a dropped connection.
 * 4. Seam: a loopback TCP relay between the client and a real listener, which the test cuts; the owner is a recording
 *    fake engine.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import net, { type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { serveOwnerEngine, type OwnerEngineServer } from '../src/core/rust-engine/owner-ipc/server.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { connectServed, type ServedConnection } from '../src/core/rust-engine/served/client.ts';
import { byteBudget, readLengthFrames } from '../src/core/rust-engine/served/framing.ts';
import { OWNER_TOKEN_IDS_CONFIG_KEY } from '../src/core/rust-engine/served/auth.ts';
import { decodeError, type Wire } from '../src/core/rust-engine/owner-ipc/codec.ts';
import type { ServedServerOptions } from '../src/core/rust-engine/served/session.ts';

const TOKEN = 'gbrain_reconnect_owner_token';
const ownerInfo = { principal: { kind: 'legacy_token', id: 'tok-1' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null };

let dir: string;
let server: OwnerEngineServer;
let listener: ServedListener;
const ran: string[] = [];
let gate: Promise<void> | null = null;

const fake = {
  kind: 'rust', capabilities: new Set<string>(['persistence_journal']),
  getConfig: async (key: string) => key === OWNER_TOKEN_IDS_CONFIG_KEY ? JSON.stringify(['tok-1']) : null,
  getPage: async (slug: unknown) => { ran.push(`getPage:${String(slug)}`); return { slug }; },
  putPage: async (slug: unknown) => { ran.push(`putPage:${String(slug)}`); if (gate) await gate; return { slug }; },
} as unknown as BrainEngine;

const servedOpts: ServedServerOptions = {
  verify: { verify: async (_engine, token) => { if (token === TOKEN) return { ...ownerInfo }; throw new Error('Invalid token'); } },
  log: () => {},
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-served-reconnect-'));
  // One permit and no queue: a second call while the first runs is refused owner_busy and never runs.
  server = (await serveOwnerEngine(fake, join(dir, 'owner.sock'), { served: servedOpts, permits: 1, maxQueued: 0 }))!;
  listener = await listenServed(server, { host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await listener?.close();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const open: Array<{ close(): void }> = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); ran.length = 0; gate = null; });

/**
 * A relay the test can cut: every connection is piped to the listener. `cut()` destroys every relayed connection (the
 * client sees its connection drop); `onBusy` cuts right after the server's first `owner_busy` answer reaches the client.
 */
async function relay(opts: { cutAfterBusy?: boolean } = {}): Promise<{ port: number; cut(): void; stop(): Promise<void>; busyCuts(): number }> {
  const sockets = new Set<Socket>();
  let busyCut = opts.cutAfterBusy === true;
  let cuts = 0;
  const cut = () => { for (const s of sockets) s.destroy(); sockets.clear(); };
  const relayServer: Server = net.createServer(client => {
    const upstream = net.createConnection({ host: '127.0.0.1', port: listener.port });
    sockets.add(client); sockets.add(upstream);
    client.on('error', () => {}); upstream.on('error', () => {});
    client.pipe(upstream);
    upstream.on('data', (chunk: Buffer) => { if (!client.destroyed) client.write(chunk); });
    readLengthFrames(upstream, {
      maxFrameBytes: () => 1 << 26, budget: byteBudget(1 << 30), onBad: () => {},
      onFrame: frame => {
        if (!busyCut || frame.t !== 'result' || frame.ok !== false) return;
        const error = decodeError(frame.error as Wire) as { code?: string };
        if (error.code !== 'owner_busy') return;
        busyCut = false;
        cuts++;
        setImmediate(cut);
      },
    });
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  });
  await new Promise<void>(resolve => relayServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (relayServer.address() as net.AddressInfo).port;
  return { port, cut, busyCuts: () => cuts, stop: () => new Promise<void>(resolve => { cut(); relayServer.close(() => resolve()); }) };
}

async function client(port: number, extra: Record<string, unknown> = {}): Promise<ServedConnection> {
  const c = await connectServed(`gbrain+tcp://127.0.0.1:${port}`, { token: TOKEN, ...extra });
  open.push(c);
  return c;
}

describe('a busy-refused call across a dropped connection', () => {
  test('is sent again fresh after the reconnect and runs once, never ending outcome_unknown', async () => {
    let release!: () => void;
    gate = new Promise(r => { release = r; });
    // Another client holds the one permit with a write that waits.
    const holder = await client(listener.port);
    const held = holder.request('call', 'putPage', ['held']);
    await Bun.sleep(20);
    const r = await relay({ cutAfterBusy: true });
    try {
      const c = await client(r.port);
      const pending = c.request('call', 'putPage', ['busy-then-drop']);
      await Bun.sleep(300);
      gate = null;
      release();
      await held;
      const out = await pending.then(v => ({ ok: true, v }), (e: unknown) => ({ ok: false, code: (e as { code?: string }).code, reason: (e as { reason?: string }).reason }));
      expect(r.busyCuts()).toBe(1);
      expect(out).toEqual({ ok: true, v: { slug: 'busy-then-drop' } });
      expect(ran.filter(x => x === 'putPage:busy-then-drop')).toHaveLength(1);
    } finally { await r.stop(); }
  });
});

describe('a connection that dropped while idle', () => {
  test('reconnects on the next call, which runs', async () => {
    const r = await relay();
    try {
      const c = await client(r.port);
      expect(await c.request('call', 'getPage', ['first'])).toEqual({ slug: 'first' });
      r.cut();
      await Bun.sleep(50);
      expect(await c.request('call', 'getPage', ['after-idle-drop'])).toEqual({ slug: 'after-idle-drop' });
    } finally { await r.stop(); }
  });

  test('a call that cannot reconnect ends owner_unavailable not_sent, not a frame-size refusal', async () => {
    const r = await relay();
    const c = await client(r.port, { reconnectMs: 300 });
    expect(await c.request('call', 'getPage', ['first'])).toEqual({ slug: 'first' });
    await r.stop();
    await Bun.sleep(50);
    const error = await c.request('call', 'putPage', ['nowhere']).then(() => null, (e: unknown) => e as { code?: string; reason?: string; message: string });
    expect({ code: error?.code, reason: error?.reason }).toEqual({ code: 'owner_unavailable', reason: 'not_sent' });
    expect(error!.message).not.toContain('larger than');
    expect(ran).not.toContain('putPage:nowhere');
  });
});

describe('a write that may have run', () => {
  test('is resent with its request id after the drop and runs once', async () => {
    let release!: () => void;
    gate = new Promise(r => { release = r; });
    const r = await relay();
    try {
      const c = await client(r.port);
      const pending = c.request('call', 'putPage', ['started']);
      await Bun.sleep(30);
      r.cut();
      await Bun.sleep(100);
      release();
      expect(await pending).toEqual({ slug: 'started' });
      expect(ran.filter(x => x === 'putPage:started')).toHaveLength(1);
    } finally { await r.stop(); }
  });
});
