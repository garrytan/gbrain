/**
 * Read-your-writes across two protocol v3 connections (interfaces I-2 and I-7; multi-writer conformance C21): a write
 * acknowledged on connection A is seen on connection B when B's read carries A's commit position as its token.
 *
 * Mode: the owner opens with GBRAIN_RUST_MULTIUSER=1 and GBRAIN_RUST_COMMIT_LOG=1 set in-run (after the preload) and the
 * test asserts its store reports `multiuser: true` and the engine `commit_log`; both clients are served engines
 * (`rust_server`) over a plain loopback v3 listener.
 *
 * 1. Protects: `readPositionToken(engine)` gives the `cp1:` token of the newest write a served engine's connection
 *    acknowledged; `withReadPosition(token, fn)` makes every served read in `fn` carry it as `min_position`, so B's
 *    read waits for A's commit, and a token past every commit ends `position_not_reached` within the read's deadline
 *    (ran nothing); a malformed token is refused before anything is sent; an engine with no served connection gives
 *    no token, and a token changes nothing on it.
 * 2. Fails on: a client that sends no min_position (the token past every commit would answer), a token that is not
 *    the acknowledged write's position.
 * 3. Existing coverage: rust-served-wire.test.ts drives min_position with raw frames only; no typed caller sent it.
 * 4. Seam: none below the engine: a real owner, a real listener, real served clients and store.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { readPositionToken, withReadPosition } from '../src/core/rust-engine/served/read-position.ts';
import { withStatementDeadline } from '../src/core/statement-deadline.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const saved = process.env.GBRAIN_RUST_MULTIUSER;
const savedLog = process.env.GBRAIN_RUST_COMMIT_LOG;
const TOKEN = 'read-position-owner-token';
let dir = '';
let owner: RustEngine;
let listener: ServedListener;
let a: RustEngine;
let b: RustEngine;

const NOTE = (title: string, body: string) => ({ type: 'note', title, compiled_truth: body, timeline: '' }) as never;

async function served(): Promise<RustEngine> {
  const engine = openRustEngine({ addon: await loadRustArmAddon(), databasePath: dir, served: { url: `gbrain+tcp://127.0.0.1:${listener.port}`, token: TOKEN } });
  await engine.connect({ engine: 'rust', database_path: dir } as never);
  return engine;
}

describeAddon('read-your-writes across two protocol v3 connections', () => {
  beforeAll(async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    // The optimistic multi-user store orders commits by its commit log (lane L2); without it the server refuses tokens.
    process.env.GBRAIN_RUST_COMMIT_LOG = '1';
    dir = mkdtempSync(join(tmpdir(), 'gbrain-read-position-'));
    owner = openRustEngine({ addon: await loadRustArmAddon(), databasePath: dir, servedOptions: {
      verify: {
        verify: async (_engine, token) => { if (token !== TOKEN) throw new Error('Invalid token'); return { principal: { kind: 'legacy_token', id: 'owner' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null }; },
        ownerIds: async () => new Set(['owner']),
      },
    } });
    await owner.connect({ engine: 'rust', database_path: dir } as never);
    listener = await listenServed(owner.ownerServer()!, { host: '127.0.0.1', port: 0 });
    a = await served();
    b = await served();
  }, 120_000);

  afterAll(async () => {
    await a?.disconnect().catch(() => undefined);
    await b?.disconnect().catch(() => undefined);
    await listener?.close().catch(() => undefined);
    await owner?.disconnect().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved;
    if (savedLog === undefined) delete process.env.GBRAIN_RUST_COMMIT_LOG; else process.env.GBRAIN_RUST_COMMIT_LOG = savedLog;
  });

  test('the owner runs multi-user and both clients are served', () => {
    expect({ multiuser: owner.openStore('read-position').multiuser, commitLog: owner.capabilities.has('commit_log'), a: a.capabilities.has('served'), b: b.capabilities.has('served') })
      .toEqual({ multiuser: true, commitLog: true, a: true, b: true });
  });

  test('a write acknowledged on A is read on B with A\'s token', async () => {
    expect(readPositionToken(a)).toBeNull();
    await a.putPage('notes/ryw', NOTE('RYW', 'written on A'));
    const token = readPositionToken(a);
    expect(token).toMatch(/^cp1:\d+\.\d+$/);
    const page = await withReadPosition(token!, () => b.getPage('notes/ryw'));
    expect(page?.compiled_truth).toBe('written on A');
  });

  test('a token past every commit ends position_not_reached at the read\'s deadline: B\'s read carries it', async () => {
    const error = await withStatementDeadline({ deadlineAt: Date.now() + 300 } as never, () => withReadPosition('cp1:999999999.0', () => b.getPage('notes/ryw')))
      .then(() => null, (e: unknown) => e as { code?: string; reason?: string });
    expect({ code: error?.code, reason: error?.reason }).toEqual({ code: 'timeout', reason: 'position_not_reached' });
  });

  test('a malformed token is refused before anything is sent; an engine with no served connection gives none', async () => {
    await expect(withReadPosition('not-a-token', async () => 1)).rejects.toMatchObject({ code: 'invalid_params' });
    expect(readPositionToken(owner)).toBeNull();
    expect((await withReadPosition('cp1:999999999.0', () => owner.getPage('notes/ryw')))?.compiled_truth).toBe('written on A');
  });
});
