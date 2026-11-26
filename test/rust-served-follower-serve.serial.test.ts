/**
 * A Rust follower following its primary over a real socket (multi-user Rust; served/follower-serve.ts).
 *
 * Mode: the test turns multi-user mode and the commit log on in-run (GBRAIN_RUST_MULTIUSER=1, GBRAIN_RUST_COMMIT_LOG=1
 * set after the test preload, the GBRAIN_TEST_RUST_MU mechanism) and asserts the primary's store reports
 * `multiuser: true` and `commitLog: true`. An environment variable set outside would be stripped by the preload.
 *
 * The primary is a Rust engine that owns its brain and serves it on a loopback listener; the follower is lane L2's napi
 * `Follower` on its own pool and directory, reached only through `followPrimary`.
 *
 * 1. Protects: an empty follower gets a whole snapshot, then later writes, and its cursor reaches the primary's newest
 *    commit; snapshot chunks never run more than the window ahead of what the follower wrote; a dropped connection
 *    resumes from the follower's cursor with no record applied twice and no second snapshot; only an owner server
 *    token may follow; a client that does not ask to follow sees the same hello as before.
 * 2. Fails on: the follower path unwired, a cursor that stalls short of the primary, a window overrun, a reconnect that
 *    re-sends what the follower holds, a non-owner token that gets in, `follower` in a hello nobody asked it for.
 * 3. Existing coverage: rust-served-follower-apply.serial.test.ts drives the frames without a socket or session.
 * 4. Seam: the bearer check is served/auth.ts's `verify` seam (owner and narrowed token shapes of the real verifier).
 *    Needs the addon `bun run rust:build` writes from a tree with L2's follower napi.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import type { RustStore } from '../src/core/rust-engine/store.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { connectServed } from '../src/core/rust-engine/served/client.ts';
import { followPrimary, type FollowerLink } from '../src/core/rust-engine/served/follower-serve.ts';
import { SERVED_SERVER_CAPS } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const OWNER_TOKEN = `gbrain_follow_owner_${process.pid}`;
const NARROW_TOKEN = `gbrain_follow_narrow_${process.pid}`;
const OWNER = { principal: { kind: 'legacy_token', id: 'follow-owner' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null };
const CHUNK = 4096;
const WINDOW = 16 * 1024;

interface FollowerHandle {
  open(dir: string): Promise<{ cursor: unknown }>;
  close(): Promise<unknown>;
  cursor(): Promise<{ sequence: number; index: number } | null>;
  applyRaw(...args: unknown[]): Promise<never>;
  installSnapshot(...args: unknown[]): Promise<never>;
}
type Addon = { Pool: new (n: number) => { shutdown(ms: number): Promise<unknown> }; Follower: new (pool: unknown) => FollowerHandle };
type Ack = Record<string, unknown>;

const saved = { mu: process.env.GBRAIN_RUST_MULTIUSER, log: process.env.GBRAIN_RUST_COMMIT_LOG };
const dirs: string[] = [];
const tmp = (name: string) => { const d = mkdtempSync(join(tmpdir(), `gbrain-follow-${name}-`)); dirs.push(d); return d; };

async function until(check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error('timed out waiting'); await Bun.sleep(20); }
}

describeAddon('a Rust follower follows its primary over a socket', () => {
  let addon: Addon;
  let primary: RustEngine;
  let store: RustStore;
  let listener: ServedListener;
  let pool: { shutdown(ms: number): Promise<unknown> };
  let follower: FollowerHandle;
  let link: FollowerLink | null = null;
  const acks: Ack[] = [];
  const received: string[] = [];
  const windows: Array<{ unacked: number; waited: boolean }> = [];
  const url = () => `gbrain+tcp://127.0.0.1:${listener.port}`;
  const newest = async () => (await store.brain.readCommitLogRaw(null, 1) as { newest: unknown }).newest;
  const caughtUp = async () => JSON.stringify(await follower.cursor()) === JSON.stringify(await newest());
  const write = async (slug: string) => primary.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '' } as never);

  beforeAll(async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    process.env.GBRAIN_RUST_COMMIT_LOG = '1';
    addon = await loadRustArmAddon() as unknown as Addon;
    const dir = tmp('primary');
    primary = openRustEngine({ addon: addon as never, databasePath: dir, servedOptions: {
      verify: {
        verify: async (_e: unknown, token: string) => {
          if (token === OWNER_TOKEN) return { ...OWNER };
          if (token === NARROW_TOKEN) return { ...OWNER, principal: { kind: 'legacy_token', id: 'follow-narrow' }, allowedOperations: ['get_page'] };
          throw new Error('Invalid token');
        },
        ownerIds: async () => new Set(['follow-owner', 'follow-narrow']),
      },
      follower: { pollMs: 20, chunkBytes: CHUNK, windowBytes: WINDOW, stagingDir: tmp('primary-staging'), onStats: (s: { unacked: number; waited: boolean }) => windows.push(s) },
    } as never });
    await primary.connect({ engine: 'rust', database_path: dir } as never);
    store = primary.openStore('follower-serve-test');
    for (let i = 0; i < 20; i++) await write(`notes/seed-${i}`);
    listener = await listenServed(primary.ownerServer()!, { host: '127.0.0.1', port: 0 });
    pool = new addon.Pool(2);
    follower = new addon.Follower(pool);
    await follower.open(join(tmp('follower'), 'brain'));
  }, 120_000);

  afterAll(async () => {
    await link?.close().catch(() => undefined);
    await follower?.close().catch(() => undefined);
    await pool?.shutdown(1000).catch(() => undefined);
    await listener?.close();
    await primary?.disconnect().catch(() => undefined);
    for (const d of dirs) { rmSync(d, { recursive: true, force: true }); rmSync(`${d}.gbrain-owner.lock`, { force: true }); }
    if (saved.mu === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved.mu;
    if (saved.log === undefined) delete process.env.GBRAIN_RUST_COMMIT_LOG; else process.env.GBRAIN_RUST_COMMIT_LOG = saved.log;
  });

  test('the primary runs in multi-user mode with a commit log', () => {
    expect({ multiuser: store.multiuser, commitLog: store.commitLog }).toEqual({ multiuser: true, commitLog: true });
  });

  test('a non-owner token is refused and the follower holds nothing', async () => {
    const error = await followPrimary({ url: url(), token: NARROW_TOKEN, follower, stagingDir: tmp('f-narrow') })
      .then(l => { void l.close(); return null; }, (e: unknown) => e as { code?: string; reason?: string });
    expect({ code: error?.code, reason: error?.reason }).toEqual({ code: 'permission_denied', reason: 'token_not_owner' });
    expect(await follower.cursor()).toBeNull();
  });

  test('a client that does not ask to follow gets the hello it always got', async () => {
    const c = await connectServed(url(), { token: OWNER_TOKEN });
    // Every v3 cap but `txn`, which needs optimistic transactions (lane L1) or the test sub-switch; never `follower`.
    try { expect([...c.caps].sort()).toEqual(SERVED_SERVER_CAPS.filter(cap => cap !== 'txn').sort()); } finally { c.close(); }
  });

  test('an empty follower gets a whole snapshot in windowed chunks, then later writes, and reaches the primary', async () => {
    link = await followPrimary({ url: url(), token: OWNER_TOKEN, follower, stagingDir: tmp('f-staging'), onAck: a => acks.push(a), onFrame: h => received.push(String(h.t)) });
    await until(caughtUp);
    // An empty follower (null cursor) starts with the snapshot: no records frame it would only refuse.
    expect(received[0]).toBe('repl_snap_begin');
    expect(acks[0]).toMatchObject({ seq: 0, ok: true });
    expect(acks.some(a => a.seq === 0 && a.ok === true)).toBe(true);
    expect(windows.length).toBeGreaterThan(0);
    expect(Math.max(...windows.map(w => w.unacked))).toBeLessThanOrEqual(WINDOW);
    expect(windows.some(w => w.waited)).toBe(true);
    const before = acks.length;
    await write('notes/later-1');
    await write('notes/later-2');
    await until(caughtUp);
    const later = acks.slice(before).filter(a => a.ok === true && (a.seq as number) > 0);
    expect(later.reduce((n, a) => n + (a.applied as number), 0)).toBeGreaterThan(0);
  }, 60_000);

  test('a dropped connection resumes from the follower cursor: nothing applied twice, no second snapshot', async () => {
    const connections = link!.connections;
    const before = acks.length;
    link!.drop();
    await write('notes/after-drop');
    await until(async () => link!.connections > connections && await caughtUp());
    const after = acks.slice(before);
    expect(after.filter(a => a.seq === 0)).toEqual([]);
    expect(after.every(a => a.ok === true && a.skipped === 0)).toBe(true);
    expect(after.reduce((n, a) => n + (a.applied as number), 0)).toBeGreaterThan(0);
  }, 60_000);
});
