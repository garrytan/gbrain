/**
 * Multi-user groundwork K (owner-ipc/remote-check.ts, audit row B2): whenever the brain runs in multi-user mode, the
 * brain owner refuses a remote caller's write itself, so a client that skips its own check (client.ts) is still
 * refused. There is no separate switch: multi-user mode alone turns the check on. Driven with raw frames, as such a
 * client would send them, on an owner with no store (the environment switch decides) and on a real Rust store opened
 * in multi-user mode (the store's own mode decides, asserted in the run). With multi-user mode off, the owner runs the
 * same frames as before.
 *
 * Needs the addon `bun run rust:build` writes (or GBRAIN_TEST_RUST_ENGINE_ADDON) for the Rust store cases.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { serveOwnerEngine } from '../src/core/rust-engine/owner-ipc/server.ts';
import { OWNER_IPC_VERSION } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { decodeError, encodeValue, type Wire } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { OWNER_REMOTE_CHECK_CAP, ownerEngineCapabilities, ownerRemoteRefusal, remoteFrameMark } from '../src/core/rust-engine/owner-ipc/remote-check.ts';
import { RUST_MULTIUSER_CONFIG_KEY } from '../src/core/rust-engine/multiuser-switch.ts';
import { OWNER_IPC_REMOTE_READS } from '../src/core/rust-engine/owner-ipc/routes.ts';
import type { OperationError } from '../src/core/ops/contract.ts';
import { rawSession, type Frame } from './helpers/owner-ipc-raw.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { rustArmAddonPath } from './engine-parity/rust-arm.ts';

const SWITCHES = ['GBRAIN_RUST_MULTIUSER', 'GBRAIN_RUST_OWNER_REMOTE_CHECK'] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of SWITCHES) { saved[k] = process.env[k]; delete process.env[k]; } });
afterAll(() => { for (const k of SWITCHES) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const on = () => { process.env.GBRAIN_RUST_MULTIUSER = '1'; };
const off = () => { for (const k of SWITCHES) delete process.env[k]; };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { off(); for (const clean of cleanups.splice(0).reverse()) await clean(); });

const hello = { t: 'hello', version: OWNER_IPC_VERSION };
/** An owner engine with no store: the switch is the environment's. */
const FAKE = {};
const errorOf = (frame: Frame | null | undefined) => decodeError(frame?.error as Wire) as OperationError;

/** An owner whose getConfig only reads and whose setConfig writes; `ran` lists what ran. */
async function owner(): Promise<{ raw: ReturnType<typeof rawSession>; ran: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-remote-check-'));
  const ran: string[] = [];
  const engine = {
    kind: 'pglite', capabilities: new Set<string>(),
    getConfig: async (key: unknown) => { ran.push(`getConfig:${String(key)}`); return 'v'; },
    setConfig: async (key: unknown) => { ran.push(`setConfig:${String(key)}`); },
  } as unknown as BrainEngine;
  const server = await serveOwnerEngine(engine, join(dir, 'owner.sock'), {
    wholeOperations: { put_page: async () => { ran.push('fn:put_page'); return { result: null, notices: [], logs: [] }; } },
  } as never);
  if (!server) throw new Error('no socket');
  cleanups.push(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const raw = rawSession(server.socketPath);
  cleanups.push(() => { raw.destroy(); });
  await raw.send(hello);
  return { raw, ran };
}

const call = (id: number, member: string, args: unknown[], extra: Frame = {}) => ({ t: 'call', id, member, args: encodeValue(args), ...extra });
const fn = (id: number, name: string, extra: Frame = {}) => ({ t: 'fn', id, name, args: encodeValue([{}]), ...extra });

describe('the owner refuses a remote caller\'s write itself under the check', () => {
  test('a write marked remote from a client that skipped its own check is refused and never runs', async () => {
    on();
    const { raw, ran } = await owner();
    await raw.send(call(1, 'setConfig', ['k'], { remote: true }));
    const refused = await raw.next(f => f.t === 'result' && f.id === 1);
    expect(refused?.ok).toBe(false);
    expect(errorOf(refused).code).toBe('engine_capability_missing');
    expect(String(errorOf(refused).message)).toContain('remote caller');
    expect(ran).toEqual([]);
  });

  test('a read marked remote still runs', async () => {
    on();
    const { raw, ran } = await owner();
    expect(OWNER_IPC_REMOTE_READS.has('getConfig')).toBe(true);
    await raw.send(call(1, 'getConfig', ['k'], { remote: true }));
    const answered = await raw.next(f => f.t === 'result' && f.id === 1);
    expect(answered?.ok).toBe(true);
    expect(ran).toEqual(['getConfig:k']);
  });

  test('a whole operation marked remote is refused and never runs', async () => {
    on();
    const { raw, ran } = await owner();
    await raw.send(fn(1, 'put_page', { remote: true }));
    const refused = await raw.next(f => f.t === 'result' && f.id === 1);
    expect(refused?.ok).toBe(false);
    expect(errorOf(refused).code).toBe('engine_capability_missing');
    expect(ran).toEqual([]);
  });

  test('a local frame still writes', async () => {
    on();
    const { raw, ran } = await owner();
    await raw.send(call(1, 'setConfig', ['k']));
    const answered = await raw.next(f => f.t === 'result' && f.id === 1);
    expect(answered?.ok).toBe(true);
    expect(ran).toEqual(['setConfig:k']);
  });

  test('an authenticated remote principal decides over the frame mark, and a frame that claims local is refused', () => {
    on();
    expect(ownerRemoteRefusal(FAKE, { t: 'call', member: 'getConfig' }, 'getConfig', true)?.message).toContain('says the caller is local');
    expect(ownerRemoteRefusal(FAKE, { t: 'call', member: 'setConfig', remote: true }, 'setConfig', true)?.message).toContain('remote caller');
    expect(ownerRemoteRefusal(FAKE, { t: 'call', member: 'getConfig', remote: true }, 'getConfig', true)).toBeNull();
    expect(ownerRemoteRefusal(FAKE, { t: 'call', member: 'setConfig', remote: true }, 'setConfig', false)).toBeNull();
  });
});

describe('with the switches off nothing changes', () => {
  test('the same remote-marked write runs as before, and the client adds no mark', async () => {
    const { raw, ran } = await owner();
    await raw.send(call(1, 'setConfig', ['k'], { remote: true }));
    const answered = await raw.next(f => f.t === 'result' && f.id === 1);
    expect(answered?.ok).toBe(true);
    expect(ran).toEqual(['setConfig:k']);
    expect(remoteFrameMark(true)).toEqual({});
  });

  test('the retired GBRAIN_RUST_OWNER_REMOTE_CHECK switch changes nothing on its own', async () => {
    process.env.GBRAIN_RUST_OWNER_REMOTE_CHECK = '1';
    expect(ownerRemoteRefusal(FAKE, { t: 'call', member: 'setConfig', remote: true }, 'setConfig')).toBeNull();
    expect(remoteFrameMark(true)).toEqual({});
  });
});

describe('on a real Rust store the store\'s own multi-user mode turns the check on', () => {
  /** A Rust brain served on an owner socket; the store resolves multi-user mode when it opens. */
  async function rustOwner(multiuser: boolean | 'config_row'): Promise<{ engine: RustEngine; raw: ReturnType<typeof rawSession>; ownerHello: Frame }> {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-remote-check-rust-'));
    const db = join(dir, 'db');
    if (multiuser === true) on(); else off();
    const engine = openRustEngine({ addon: await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: rustArmAddonPath() } }), databasePath: db });
    await engine.connect({ engine: 'rust', database_path: db } as never);
    await engine.initSchema();
    await engine.setConfig('k', 'before');
    if (multiuser === 'config_row') {
      // Multi-user by the brain's own config row alone: the environment switch stays unset; the store reads the row at open.
      await engine.setConfig(RUST_MULTIUSER_CONFIG_KEY, '1');
      await engine.disconnect();
      await engine.connect({ engine: 'rust', database_path: db } as never);
    }
    const server = await serveOwnerEngine(engine, join(dir, 'owner.sock'));
    if (!server) throw new Error('no socket');
    cleanups.push(async () => { await server.close(); await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });
    const raw = rawSession(server.socketPath);
    cleanups.push(() => { raw.destroy(); });
    await raw.send(hello);
    const ownerHello = await raw.next(f => f.t === 'hello');
    if (!ownerHello) throw new Error('no owner hello');
    return { engine, raw, ownerHello };
  }

  test('in multi-user mode a remote write frame is refused and the store keeps its value; a remote read runs', async () => {
    const { engine, raw } = await rustOwner(true);
    expect(engine.openStore('owner-remote-check-test').multiuser).toBe(true);
    await raw.send(call(1, 'setConfig', ['k', 'after'], { remote: true }));
    const refused = await raw.next(f => f.t === 'result' && f.id === 1);
    expect({ ok: refused?.ok, code: refused?.ok === false ? errorOf(refused).code : null }).toEqual({ ok: false, code: 'engine_capability_missing' });
    await raw.send(call(2, 'getConfig', ['k'], { remote: true }));
    const read = await raw.next(f => f.t === 'result' && f.id === 2);
    expect(read?.ok).toBe(true);
    expect(await engine.getConfig('k')).toBe('before');
    await raw.send(fn(3, 'put_page', { remote: true }));
    expect((await raw.next(f => f.t === 'result' && f.id === 3))?.ok).toBe(false);
  });

  test('a brain multi-user by its config row alone advertises the check in its hello, and a client marks remote frames by it', async () => {
    const { engine, raw, ownerHello } = await rustOwner('config_row');
    expect(process.env.GBRAIN_RUST_MULTIUSER).toBeUndefined();
    expect(engine.openStore('owner-remote-check-test').multiuser).toBe(true);
    const caps = ownerHello.capabilities as string[];
    expect(caps).toContain(OWNER_REMOTE_CHECK_CAP);
    // The client's environment switch is off, so only the owner's hello can make it mark a remote caller's frame.
    expect(remoteFrameMark(true, caps)).toEqual({ remote: true });
    expect(remoteFrameMark(false, caps)).toEqual({});
    expect(remoteFrameMark(true, [])).toEqual({});
    // The client's own engine capabilities never list the hello-only mark.
    expect(ownerEngineCapabilities(caps)).not.toContain(OWNER_REMOTE_CHECK_CAP);
    expect(ownerEngineCapabilities(caps)).toEqual(caps.filter(c => c !== OWNER_REMOTE_CHECK_CAP));
    await raw.send(call(1, 'setConfig', ['k', 'after'], { ...remoteFrameMark(true, caps) }));
    expect((await raw.next(f => f.t === 'result' && f.id === 1))?.ok).toBe(false);
    expect(await engine.getConfig('k')).toBe('before');
  });

  test('a store opened single-user runs the same remote write frame, even with the switch set afterwards', async () => {
    const { engine, raw, ownerHello } = await rustOwner(false);
    expect(ownerHello.capabilities as string[]).not.toContain(OWNER_REMOTE_CHECK_CAP);
    on();
    expect(engine.openStore('owner-remote-check-test').multiuser).toBe(false);
    await raw.send(call(1, 'setConfig', ['k', 'after'], { remote: true }));
    expect((await raw.next(f => f.t === 'result' && f.id === 1))?.ok).toBe(true);
    expect(await engine.getConfig('k')).toBe('after');
  });
});
