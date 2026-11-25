/**
 * Multi-user groundwork K (owner-ipc/remote-check.ts): with GBRAIN_RUST_MULTIUSER=1 and
 * GBRAIN_RUST_OWNER_REMOTE_CHECK=1, the brain owner refuses a remote caller's write itself, so a client that skips its
 * own check (client.ts) is still refused. Driven with raw frames, as such a client would send them. With the switches
 * off, the owner runs the same frames as before.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { serveOwnerEngine } from '../src/core/rust-engine/owner-ipc/server.ts';
import { OWNER_IPC_VERSION } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { decodeError, encodeValue, type Wire } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { ownerRemoteRefusal, remoteFrameMark } from '../src/core/rust-engine/owner-ipc/remote-check.ts';
import { OWNER_IPC_REMOTE_READS } from '../src/core/rust-engine/owner-ipc/routes.ts';
import type { OperationError } from '../src/core/ops/contract.ts';
import { rawSession, type Frame } from './helpers/owner-ipc-raw.ts';

const SWITCHES = ['GBRAIN_RUST_MULTIUSER', 'GBRAIN_RUST_OWNER_REMOTE_CHECK'] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of SWITCHES) { saved[k] = process.env[k]; delete process.env[k]; } });
afterAll(() => { for (const k of SWITCHES) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const on = () => { process.env.GBRAIN_RUST_MULTIUSER = '1'; process.env.GBRAIN_RUST_OWNER_REMOTE_CHECK = '1'; };
const off = () => { for (const k of SWITCHES) delete process.env[k]; };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { off(); for (const clean of cleanups.splice(0).reverse()) await clean(); });

const hello = { t: 'hello', version: OWNER_IPC_VERSION };
/** An owner engine with no store: the switch is the environment's. */
const FAKE = {};
const errorOf = (frame: Frame | null | undefined) => decodeError(frame?.error as Wire) as OperationError;

/** An owner whose getConfig only reads and whose setConfig writes; `ran` lists what ran. */
async function owner() {
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

  test('the sub-switch alone changes nothing', async () => {
    process.env.GBRAIN_RUST_OWNER_REMOTE_CHECK = '1';
    expect(ownerRemoteRefusal(FAKE, { t: 'call', member: 'setConfig', remote: true }, 'setConfig')).toBeNull();
    expect(remoteFrameMark(true)).toEqual({});
  });
});
