/**
 * Decision R on the owner socket (docs/designs/rust-engine/multi-user-server.md, "Request ids, positions and busy
 * owners"): in multi-user mode a busy owner is waited for, not reported. The owner-socket client (owner-ipc/client.ts)
 * sends a call refused with `owner_busy` (queue_full, inflight_bytes) again after a backoff, and the election
 * (owner-ipc/election.ts) connects again after `owner_busy` connections, inside the caller's deadline (60 s when it has
 * none). The caller sees `timeout` only at its own deadline, and a refused call never runs.
 *
 * 1. Protects: in multi-user mode many processes share one owner, so its caps are reached in normal use; a caller that
 *    got `owner_busy` back would fail work that a short wait admits.
 * 2. Fails on: a client that hands `owner_busy` to the caller in multi-user mode, retries past the caller's deadline,
 *    runs a refused call twice, or retries with the mode off (the rust-owner-ipc-limits.test.ts pins).
 * 3. Existing coverage: rust-owner-ipc-limits.test.ts pins the owner's refusals on raw frames and the one-shot connect
 *    refusal; served-client tests cover decision R on the network wire only.
 * 4. Seam: fake owners on `serveOwnerEngine` with small caps, a raw session that holds the caps, and the mode read in
 *    two ways: the environment switch (set in this run) and the owner's store (`openStoreIfOpen().multiuser`, the
 *    config row's answer) with the switch unset.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { serveOwnerEngine, type OwnerServerOptions } from '../src/core/rust-engine/owner-ipc/server.ts';
import { connectOwner, type OwnerConnection } from '../src/core/rust-engine/owner-ipc/client.ts';
import { electOwner, type OwnerRole } from '../src/core/rust-engine/owner-ipc/election.ts';
import { OWNER_IPC_VERSION } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { OWNER_REMOTE_CHECK_CAP } from '../src/core/rust-engine/owner-ipc/remote-check.ts';
import { encodeValue } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { RUST_MULTIUSER_ENV, rustMultiuserFromEnv } from '../src/core/rust-engine/multiuser-switch.ts';
import { withReadDeadline } from '../src/core/read-deadline.ts';
import { requestSignal } from '../src/core/request-signal.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { rawSession } from './helpers/owner-ipc-raw.ts';

type Mode = 'env' | 'config' | 'off';
const hello = { t: 'hello', version: OWNER_IPC_VERSION };
const call = (id: number, member: string, args: unknown[]) => ({ t: 'call', id, member, args: encodeValue(args) });

const savedSwitch = process.env[RUST_MULTIUSER_ENV];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
  if (savedSwitch === undefined) delete process.env[RUST_MULTIUSER_ENV];
  else process.env[RUST_MULTIUSER_ENV] = savedSwitch;
});

/**
 * Sets the mode for this case: `env` turns the environment switch on; `config` leaves it off and gives the owner a
 * store in multi-user mode (as the brain's config row would); `off` leaves both off.
 */
function setMode(mode: Mode): void {
  if (mode === 'env') process.env[RUST_MULTIUSER_ENV] = '1';
  else delete process.env[RUST_MULTIUSER_ENV];
  expect(rustMultiuserFromEnv()).toBe(mode === 'env');
}

/** An owner whose getHealth runs until its call is cancelled, and whose getConfig answers at once. */
function blockingEngine(mode: Mode, ran: string[]): BrainEngine {
  const store = mode === 'config' ? { multiuser: true } : null;
  return {
    kind: 'pglite', capabilities: new Set<string>(),
    openStoreIfOpen: () => store,
    getHealth: (tag: unknown) => {
      ran.push(`getHealth:${String(tag).slice(0, 12)}`);
      return new Promise((_resolve, reject) => {
        requestSignal()?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
    getConfig: async (key: unknown) => { ran.push(`getConfig:${String(key).slice(0, 12)}`); return 'value'; },
  } as unknown as BrainEngine;
}

async function blockingOwner(mode: Mode, opts: OwnerServerOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-busy-'));
  const ran: string[] = [];
  const server = await serveOwnerEngine(blockingEngine(mode, ran), join(dir, 'owner.sock'), opts);
  if (!server) throw new Error('no socket');
  cleanups.push(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { server, ran };
}

async function client(socketPath: string, mode: Mode): Promise<OwnerConnection> {
  const connection = await connectOwner(socketPath);
  cleanups.push(() => connection.close());
  // Mode-on evidence: a multi-user owner lists the remote check in its hello; with the mode off it does not.
  expect(connection.hello.capabilities.includes(OWNER_REMOTE_CHECK_CAP)).toBe(mode !== 'off');
  return connection;
}

/** Settles `promise` into a record the test reads without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state: { done: boolean; value?: T; error?: OperationError; at?: number } = { done: false };
  promise.then(v => { state.done = true; state.value = v; state.at = Date.now(); },
    e => { state.done = true; state.error = e as OperationError; state.at = Date.now(); });
  return state;
}

async function until(done: () => boolean, ms = 4_000): Promise<void> {
  for (let i = 0; i < ms / 25 && !done(); i++) await Bun.sleep(25);
}

const ON: Mode[] = ['env', 'config'];

describe('multi-user mode: a call refused queue_full is sent again and admitted once a slot frees', () => {
  for (const mode of ON) {
    test(`${mode}: the caller waits, never sees owner_busy, and the call runs exactly once`, async () => {
      setMode(mode);
      const { server, ran } = await blockingOwner(mode, { permits: 1, maxQueued: 1 });
      const raw = rawSession(server.socketPath);
      cleanups.push(() => { raw.destroy(); });
      await raw.send(hello);
      await raw.send(call(1, 'getHealth', ['running']));
      await raw.send(call(2, 'getHealth', ['queued']));
      await until(() => server.stats().queued === 1);
      const connection = await client(server.socketPath, mode);
      const outcome = track(connection.request('call', 'getConfig', ['over']));
      await Bun.sleep(300);
      expect(outcome.done).toBe(false);
      expect(ran).not.toContain('getConfig:over');
      // Free the queue slot and the permit: the next resend is admitted and runs.
      await raw.send({ t: 'cancel', id: 2 });
      await raw.send({ t: 'cancel', id: 1 });
      await until(() => outcome.done);
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toBe('value');
      expect(ran.filter(r => r === 'getConfig:over')).toHaveLength(1);
    }, 20_000);
  }
});

describe('multi-user mode: a call that stays refused ends timeout at the caller deadline and never runs', () => {
  for (const mode of ON) {
    test(`${mode}: queue_full until the read deadline gives timeout (not_started), not owner_busy`, async () => {
      setMode(mode);
      const { server, ran } = await blockingOwner(mode, { permits: 1, maxQueued: 1 });
      const raw = rawSession(server.socketPath);
      cleanups.push(() => { raw.destroy(); });
      await raw.send(hello);
      await raw.send(call(1, 'getHealth', ['running']));
      await raw.send(call(2, 'getHealth', ['queued']));
      await until(() => server.stats().queued === 1);
      const connection = await client(server.socketPath, mode);
      const startedAt = Date.now();
      const outcome = track(withReadDeadline(startedAt + 600, () => connection.request('call', 'getConfig', ['over'])));
      await until(() => outcome.done);
      expect(outcome.error).toBeInstanceOf(OperationError);
      expect({ code: outcome.error?.code, reason: outcome.error?.reason, retryable: outcome.error?.retryable })
        .toEqual({ code: 'timeout', reason: 'not_started', retryable: true });
      // At the caller's own deadline: not at once, and not at the client's grace timer past it.
      expect(outcome.at! - startedAt).toBeGreaterThanOrEqual(550);
      expect(outcome.at! - startedAt).toBeLessThan(2_000);
      expect(ran).not.toContain('getConfig:over');
    }, 20_000);
  }
});

describe('multi-user mode: a call refused inflight_bytes is sent again and admitted once bytes free', () => {
  for (const mode of ON) {
    test(`${mode}: the large call waits for the running one to give back its bytes, then runs once`, async () => {
      setMode(mode);
      const { server, ran } = await blockingOwner(mode, { permits: 4, maxInflightBytes: 1_000 });
      const raw = rawSession(server.socketPath);
      cleanups.push(() => { raw.destroy(); });
      const big = 'x'.repeat(600);
      await raw.send(hello);
      await raw.send(call(1, 'getHealth', [big]));
      await until(() => server.stats().active === 1);
      const connection = await client(server.socketPath, mode);
      const outcome = track(connection.request('call', 'getConfig', [big]));
      await Bun.sleep(300);
      expect(outcome.done).toBe(false);
      expect(ran.filter(r => r.startsWith('getConfig:'))).toHaveLength(0);
      await raw.send({ t: 'cancel', id: 1 });
      await until(() => outcome.done);
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toBe('value');
      expect(ran.filter(r => r.startsWith('getConfig:'))).toHaveLength(1);
    }, 20_000);
  }
});

describe('multi-user mode: an election refused for connections connects again once a connection frees', () => {
  async function electedOwner(mode: Mode) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-busy-elect-'));
    const db = join(dir, 'brain.rust');
    const ran: string[] = [];
    const role = await electOwner(blockingEngine(mode, ran), db, { maxConnections: 1 });
    if (role.role !== 'owner') throw new Error('this process must own the brain');
    cleanups.push(async () => { await role.server.close(); await role.lock.release(); rmSync(dir, { recursive: true, force: true }); });
    const raw = rawSession(role.server.socketPath);
    cleanups.push(() => { raw.destroy(); });
    await raw.send(hello);
    expect(await raw.next(f => f.t === 'hello')).not.toBeNull();
    return { db, raw, ran };
  }

  for (const mode of ON) {
    test(`${mode}: past a short election wait, the client connects as soon as the held connection closes`, async () => {
      setMode(mode);
      const { db, raw } = await electedOwner(mode);
      const second = track<OwnerRole>(electOwner(blockingEngine(mode, []), db, { waitMs: 200 }));
      await Bun.sleep(600);
      expect(second.error).toBeUndefined();
      expect(second.done).toBe(false);
      raw.destroy();
      await until(() => second.done);
      expect(second.error).toBeUndefined();
      expect(second.value?.role).toBe('client');
      if (second.value?.role === 'client') {
        cleanups.push(() => (second.value as { connection: OwnerConnection }).connection.close());
        expect(await second.value.connection.request('call', 'getConfig', ['after'])).toBe('value');
      }
    }, 20_000);

    test(`${mode}: a connection that never frees ends timeout (not_sent) at the read deadline`, async () => {
      setMode(mode);
      const { db } = await electedOwner(mode);
      const startedAt = Date.now();
      const second = track<OwnerRole>(withReadDeadline(startedAt + 600, () => electOwner(blockingEngine(mode, []), db, { waitMs: 100 })));
      await until(() => second.done);
      expect(second.error).toBeInstanceOf(OperationError);
      expect({ code: second.error?.code, reason: second.error?.reason, retryable: second.error?.retryable })
        .toEqual({ code: 'timeout', reason: 'not_sent', retryable: true });
      expect(second.at! - startedAt).toBeGreaterThanOrEqual(550);
      expect(second.at! - startedAt).toBeLessThan(2_000);
    }, 20_000);
  }
});

describe('multi-user mode off: owner_busy reaches the caller at once, as rust-owner-ipc-limits.test.ts pins', () => {
  test('queue_full is not sent again', async () => {
    setMode('off');
    const { server, ran } = await blockingOwner('off', { permits: 1, maxQueued: 1 });
    const raw = rawSession(server.socketPath);
    cleanups.push(() => { raw.destroy(); });
    await raw.send(hello);
    await raw.send(call(1, 'getHealth', ['running']));
    await raw.send(call(2, 'getHealth', ['queued']));
    await until(() => server.stats().queued === 1);
    const connection = await client(server.socketPath, 'off');
    const startedAt = Date.now();
    const error = await connection.request('call', 'getConfig', ['over']).then(() => null, e => e as OperationError);
    expect({ code: error?.code, reason: error?.reason }).toEqual({ code: 'owner_busy', reason: 'queue_full' });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(ran).not.toContain('getConfig:over');
  }, 20_000);

  test('inflight_bytes is not sent again', async () => {
    setMode('off');
    const { server } = await blockingOwner('off', { permits: 4, maxInflightBytes: 1_000 });
    const raw = rawSession(server.socketPath);
    cleanups.push(() => { raw.destroy(); });
    const big = 'x'.repeat(600);
    await raw.send(hello);
    await raw.send(call(1, 'getHealth', [big]));
    await until(() => server.stats().active === 1);
    const connection = await client(server.socketPath, 'off');
    const error = await connection.request('call', 'getConfig', [big]).then(() => null, e => e as OperationError);
    expect({ code: error?.code, reason: error?.reason }).toEqual({ code: 'owner_busy', reason: 'inflight_bytes' });
  }, 20_000);

  test('the election ends with owner_busy connections at once', async () => {
    setMode('off');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-busy-off-'));
    const db = join(dir, 'brain.rust');
    const role = await electOwner(blockingEngine('off', []), db, { maxConnections: 1 });
    if (role.role !== 'owner') throw new Error('this process must own the brain');
    cleanups.push(async () => { await role.server.close(); await role.lock.release(); rmSync(dir, { recursive: true, force: true }); });
    const raw = rawSession(role.server.socketPath);
    cleanups.push(() => { raw.destroy(); });
    await raw.send(hello);
    expect(await raw.next(f => f.t === 'hello')).not.toBeNull();
    const startedAt = Date.now();
    const error = await electOwner(blockingEngine('off', []), db, { waitMs: 3_000 }).then(() => null, e => e as OperationError);
    expect({ code: error?.code, reason: error?.reason }).toEqual({ code: 'owner_busy', reason: 'connections' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  }, 20_000);
});
