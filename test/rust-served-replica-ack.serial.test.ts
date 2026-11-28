/**
 * Replica acks end to end: a Rust primary serves its brain, a Rust follower follows it as a named replica, and a
 * served write is answered as a success only once that replica holds it (multi-user Rust; rust/docs/store/commit-log.md,
 * "Replica acks"; served/replica-gate.ts, served/follower-serve.ts).
 *
 * Mode: the test turns multi-user mode and the commit log on in-run (GBRAIN_RUST_MULTIUSER=1, GBRAIN_RUST_COMMIT_LOG=1,
 * plus the two replica-ack settings, set after the test preload, the GBRAIN_TEST_RUST_MU mechanism).
 *
 * 1. Protects: with a replica attached, a write's success answer (call, retry of a finished write, top-level
 *    transaction commit) comes only after the replica's cursor holds the write, with or without the client's
 *    `positions` capability; a stopped replica turns the answer into `replication_timeout` (reason `outcome_unknown`)
 *    while the commit stays durable on the primary, and a retry of the same request id answers success once the
 *    replica is back; past `max_waiters` a write is refused `replication_busy` before it runs and nothing is written,
 *    while reads still answer; a detach (from the link or from any owner connection) ends the waits without success
 *    and later writes answer at once; an owner close ends the waits `replication_timeout`.
 * 2. Fails on: a success answer before the follower's cursor reaches the write; a timeout that lost the primary's
 *    commit; a retry that runs a write again; a busy refusal that wrote; a read held behind the waits; a wait that
 *    survives a detach or a close; an answer lost after the engine call settled.
 * 3. Existing coverage: rust-served-replica-gate.test.ts (the gate against a fake store),
 *    rust-served-follower-serve.serial.test.ts (following without a replica), and the store's
 *    rust/crates/gbrain-store/tests/replica_ack.rs.
 * 4. Seam: the bearer check is served/auth.ts's `verify` seam; `transactions` is the served-options switch the test
 *    sub-switch sets (protocol evidence for the commit gate). Needs the addon `bun run rust:build` writes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import net, { type Socket } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import type { RustStore } from '../src/core/rust-engine/store.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { detachReplicaAt, followPrimary, type FollowerLink } from '../src/core/rust-engine/served/follower-serve.ts';
import { encodeLengthFrame, readLengthFrames, byteBudget } from '../src/core/rust-engine/served/framing.ts';
import { decodeError, decodeValue, encodeValue, type Wire } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const OWNER_TOKEN = `gbrain_replica_owner_${process.pid}`;
const OWNER = { principal: { kind: 'legacy_token', id: 'replica-owner' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null };
const TIMEOUT_MS = 2_500;
const MAX_WAITERS = 3;
const ENV = {
  GBRAIN_RUST_MULTIUSER: '1', GBRAIN_RUST_COMMIT_LOG: '1',
  GBRAIN_RUST_REPLICA_ACK_TIMEOUT_MS: String(TIMEOUT_MS), GBRAIN_RUST_REPLICA_ACK_MAX_WAITERS: String(MAX_WAITERS),
} as const;

type Pos = { sequence: number; index: number };
type Frame = Record<string, unknown>;
interface FollowerHandle {
  open(dir: string): Promise<unknown>;
  close(): Promise<unknown>;
  cursor(): Promise<Pos | null>;
}
type Addon = { Pool: new (n: number) => { shutdown(ms: number): Promise<unknown> }; Follower: new (pool: unknown) => FollowerHandle };

const saved = Object.fromEntries(Object.keys(ENV).map(k => [k, process.env[k]]));
const dirs: string[] = [];
const tmp = (name: string) => { const d = mkdtempSync(join(tmpdir(), `gbrain-replica-${name}-`)); dirs.push(d); return d; };
const atOrAfter = (a: Pos | null, b: Pos) => !!a && (a.sequence > b.sequence || (a.sequence === b.sequence && a.index >= b.index));
const errorOf = (f: Frame) => decodeError(f.error as Wire) as { code?: string; reason?: string; detail?: string };

async function until(check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error('timed out waiting'); await Bun.sleep(20); }
}

describeAddon('replica acks over a served primary', () => {
  let addon: Addon;
  let primary: RustEngine;
  let store: RustStore;
  let listener: ServedListener;
  let pool: { shutdown(ms: number): Promise<unknown> };
  let follower: FollowerHandle;
  let link: FollowerLink | null = null;
  const marks: Pos[] = [];
  const url = () => `gbrain+tcp://127.0.0.1:${listener.port}`;
  const page = (slug: string) => ({ type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '' });
  const newest = async () => (await store.brain.readCommitLogRaw(null, 1) as { newest: Pos | null }).newest;
  const cover = async () => await (store.brain as unknown as { replicaCover(p: Pos): Promise<{ required: boolean; covered: boolean }> }).replicaCover({ sequence: 0, index: 0 });
  const follow = async (replica: string) => {
    link = await followPrimary({ url: url(), token: OWNER_TOKEN, follower: follower as never, stagingDir: tmp('f-staging'), replica,
      onFrame: h => { if (h.t === 'repl_mark') marks.push(h.acked as Pos); } });
    await until(async () => atOrAfter(await follower.cursor(), (await newest())!) && (await cover()).covered);
  };
  const stop = async () => { await link?.close(); link = null; };

  /** A raw protocol v3 peer, so the test chooses request ids and capabilities. */
  async function peer(caps: string[] = ['request_ids', 'positions']) {
    const socket = await new Promise<Socket>(resolve => { const s = net.createConnection({ host: '127.0.0.1', port: listener.port }, () => resolve(s)); s.on('error', () => {}); });
    const byId = new Map<number, (f: Frame) => void>();
    const early = new Map<number, Frame>();
    const closed = new Promise<void>(r => socket.once('close', () => r()));
    let hello!: (f: Frame) => void;
    const helloed = new Promise<Frame>(r => { hello = r; });
    readLengthFrames(socket, { maxFrameBytes: () => 1 << 26, budget: byteBudget(1 << 30), onBad: () => {}, onFrame: f => {
      if (f.t === 'hello') { hello(f); return; }
      const id = Number(f.id); const w = byId.get(id);
      if (w) { byId.delete(id); w(f); } else early.set(id, f);
    } });
    const send = (f: Frame) => socket.write(encodeLengthFrame(f)!);
    send({ t: 'hello', v: 3, version: 3, caps, auth: { scheme: 'bearer', token: OWNER_TOKEN } });
    await helloed;
    let next = 1;
    const ask = (f: Frame): Promise<Frame> => {
      const id = next++;
      return new Promise<Frame>(resolve => {
        const got = early.get(id);
        if (got) { early.delete(id); resolve(got); return; }
        byId.set(id, resolve);
        send({ ...f, id });
      });
    };
    return {
      socket, closed,
      put: (slug: string, req = Bun.randomUUIDv7(), extra: Frame = {}) => ask({ t: 'call', member: 'putPage', args: encodeValue([slug, page(slug)]), req, ...extra }),
      get: (slug: string) => ask({ t: 'call', member: 'getPage', args: encodeValue([slug]), req: Bun.randomUUIDv7() }),
      txn: (op: string, txn?: string) => ask({ t: 'txn', op, ...(txn ? { txn } : {}) }),
    };
  }

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    addon = await loadRustArmAddon() as unknown as Addon;
    const dir = tmp('primary');
    primary = openRustEngine({ addon: addon as never, databasePath: dir, servedOptions: {
      verify: {
        verify: async (_e: unknown, token: string) => { if (token === OWNER_TOKEN) return { ...OWNER }; throw new Error('Invalid token'); },
        ownerIds: async () => new Set(['replica-owner']),
      },
      follower: { pollMs: 20, stagingDir: tmp('primary-staging') },
      transactions: () => true,
    } as never });
    await primary.connect({ engine: 'rust', database_path: dir } as never);
    store = primary.openStore('replica-ack-test');
    for (let i = 0; i < 5; i++) await primary.putPage(`notes/seed-${i}`, page(`notes/seed-${i}`) as never);
    listener = await listenServed(primary.ownerServer()!, { host: '127.0.0.1', port: 0 });
    pool = new addon.Pool(2);
    follower = new addon.Follower(pool);
    await follower.open(join(tmp('follower'), 'brain'));
  }, 120_000);

  afterAll(async () => {
    await link?.close().catch(() => undefined);
    await follower?.close().catch(() => undefined);
    await pool?.shutdown(1000).catch(() => undefined);
    await listener?.close().catch(() => undefined);
    await primary?.disconnect().catch(() => undefined);
    for (const d of dirs) { rmSync(d, { recursive: true, force: true }); rmSync(`${d}.gbrain-owner.lock`, { force: true }); }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test('the store reads the replica-ack settings from the environment; no replica is attached yet', async () => {
    expect({ multiuser: store.multiuser, commitLog: store.commitLog }).toEqual({ multiuser: true, commitLog: true });
    expect(await (store.brain as unknown as { replicaAckSettings(): Promise<unknown> }).replicaAckSettings()).toEqual({ timeout_ms: TIMEOUT_MS, max_waiters: MAX_WAITERS });
    expect((await cover()).required).toBe(false);
  });

  test('a follower that names itself is attached, and a write answers success only once the follower holds it', async () => {
    await follow('replica-1');
    expect((await cover()).required).toBe(true);
    const p = await peer();
    for (let i = 0; i < 5; i++) {
      const answer = await p.put(`notes/held-${i}`);
      expect(answer.ok).toBe(true);
      const position = answer.position as Pos;
      expect(atOrAfter(await follower.cursor(), position)).toBe(true);
    }
    expect(marks.length).toBeGreaterThan(0);
    // A client without `positions` gets no position on the wire, and still waits for the replica.
    const bare = await peer(['request_ids']);
    const answer = await bare.put('notes/held-bare');
    expect(answer.ok).toBe(true);
    expect(answer.position).toBeUndefined();
    expect(atOrAfter(await follower.cursor(), (await newest())!)).toBe(true);
    p.socket.destroy(); bare.socket.destroy();
  }, 60_000);

  test('a top-level transaction commit answers success only once the follower holds it', async () => {
    const p = await peer(['request_ids', 'positions', 'txn']);
    const begin = await p.txn('begin');
    expect(begin.ok).toBe(true);
    const ref = decodeValue(begin.value as Wire) as string;
    expect((await p.put('notes/in-txn', Bun.randomUUIDv7(), { txn: ref })).ok).toBe(true);
    const commit = await p.txn('commit', ref);
    expect(commit.ok).toBe(true);
    const position = decodeValue(commit.value as Wire) as Pos;
    expect(atOrAfter(await follower.cursor(), position)).toBe(true);
    p.socket.destroy();
  }, 60_000);

  test('a stopped replica: replication_timeout, the commit stays on the primary, and the same request id answers success once it is back', async () => {
    await stop();
    const p = await peer();
    const req = Bun.randomUUIDv7();
    const started = Date.now();
    const first = await p.put('notes/unacked', req);
    expect(Date.now() - started).toBeGreaterThanOrEqual(TIMEOUT_MS - 100);
    expect(first.ok).toBe(false);
    expect(errorOf(first)).toMatchObject({ code: 'replication_timeout', reason: 'outcome_unknown' });
    expect(errorOf(first).detail).toContain('durable=primary');
    expect(((await primary.getPage('notes/unacked')) as { title?: string } | null)?.title).toBe('notes/unacked');
    const committedAt = await newest();
    await follow('replica-1');
    const again = await p.put('notes/unacked', req, { retry: true });
    expect(again.ok).toBe(true);
    // Answered from the stored outcome: the write did not run again.
    expect(await newest()).toEqual(committedAt);
    expect(atOrAfter(await follower.cursor(), again.position as Pos)).toBe(true);
    p.socket.destroy();
  }, 60_000);

  test('past max_waiters a write is refused replication_busy before it runs; reads answer; a detach ends the waits', async () => {
    await stop();
    const p = await peer();
    const waiting = Array.from({ length: MAX_WAITERS }, (_, i) => p.put(`notes/wait-${i}`));
    await until(async () => (await primary.getPage(`notes/wait-${MAX_WAITERS - 1}`)) !== null, TIMEOUT_MS / 2);
    await Bun.sleep(100); // the last commit's answer joins the waits
    const busy = await p.put('notes/busy');
    expect(errorOf(busy)).toMatchObject({ code: 'replication_busy' });
    expect(await primary.getPage('notes/busy')).toBeNull();
    const read = await p.get('notes/seed-0');
    expect(read.ok).toBe(true);
    // Any owner connection may detach: a one-shot one, with no link.
    expect(await detachReplicaAt({ url: url(), token: OWNER_TOKEN, replica: 'replica-1', reason: 'replica host lost' })).toBe(true);
    const ended = await Promise.all(waiting);
    for (const f of ended) {
      expect(errorOf(f)).toMatchObject({ code: 'replication_timeout', reason: 'outcome_unknown' });
      expect(errorOf(f).detail).toContain('end=detached');
    }
    expect((await cover()).required).toBe(false);
    const started = Date.now();
    expect((await p.put('notes/after-detach')).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS);
    p.socket.destroy();
  }, 60_000);

  test('a link detaches its own replica', async () => {
    await follow('replica-2');
    expect((await cover()).required).toBe(true);
    expect(await link!.detach('moving the replica')).toBe(true);
    expect((await cover()).required).toBe(false);
    await stop();
  }, 60_000);

  test('an owner close ends every wait replication_timeout, answered before the connection closes', async () => {
    await follow('replica-3');
    await stop();
    const p = await peer();
    const waiting = p.put('notes/at-close');
    await until(async () => (await primary.getPage('notes/at-close')) !== null, TIMEOUT_MS / 2);
    await Bun.sleep(100);
    await primary.disconnect();
    const answer = await Promise.race([waiting, p.closed.then(() => null)]);
    expect(answer).not.toBeNull();
    expect(errorOf(answer!)).toMatchObject({ code: 'replication_timeout', reason: 'outcome_unknown' });
    expect(errorOf(answer!).detail).toContain('end=closed');
  }, 60_000);
});
