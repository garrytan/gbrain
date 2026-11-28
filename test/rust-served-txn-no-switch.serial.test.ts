/**
 * Interactive transactions over the wire with no test switch (multi-user lane L1): a multi-user Rust owner offers the
 * `txn` capability because its engine reports `multi_writer` (optimistic explicit transactions), and only then.
 *
 * Mode: the owner opens with GBRAIN_RUST_MULTIUSER=1 set in-run and GBRAIN_RUST_SERVED_SERIAL_TXN unset; the test
 * asserts the owner's store reports `multiuser: true` and that the client reports `served` and `multi_writer`.
 *
 * 1. Protects: a served client of a multi-user owner runs `transaction(fn)` on the server (commit, rollback, and
 *    concurrent read-modify-writes from two clients that lose commits to each other and run again), with no switch set;
 *    a server engine without `multi_writer` never offers `txn`, whatever the environment says.
 * 2. Fails on: an owner that offers transactions over the wire only under the retired test-only sub-switch (the served
 *    parity arm then refuses every client transaction); the retired switch turning `txn` on for an engine without
 *    `multi_writer` (on the base, GBRAIN_RUST_SERVED_SERIAL_TXN=1 still did).
 * 3. Existing coverage: rust-served-txn-retry.test.ts and rust-served-wire.test.ts run against fakes that force
 *    `transactions: () => true`; the served parity arm set the switch from GBRAIN_TEST_RUST_SERVED_SERIAL_TXN.
 * 4. Seam: none below the engine: a real owner, a real listener and real served clients; servedServerOptionsFor
 *    is called directly only for the engine without `multi_writer`, which a real multi-user owner never is.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { servedServerOptionsFor } from '../src/core/rust-engine/served/serve-listen.ts';
import { servedConnectionOf } from '../src/core/rust-engine/served/store-returning.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

/** The retired test-only sub-switch: nothing may read it any more. */
const RETIRED_SWITCH = 'GBRAIN_RUST_SERVED_SERIAL_TXN';
const saved = { multiuser: process.env.GBRAIN_RUST_MULTIUSER, retired: process.env[RETIRED_SWITCH] };
function restoreEnv(): void {
  if (saved.multiuser === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved.multiuser;
  if (saved.retired === undefined) delete process.env[RETIRED_SWITCH]; else process.env[RETIRED_SWITCH] = saved.retired;
}

const TOKEN = 'served-txn-no-switch-owner-token';
const page = (title: string) => ({ type: 'note', title, compiled_truth: `${title} body.`, timeline: '' }) as never;
const titleOf = async (engine: RustEngine, slug: string) => (await engine.getPage(slug))?.title ?? null;

describe('the retired switch never offers transactions over the wire', () => {
  afterAll(restoreEnv);

  test('a multi-user engine without multi_writer gets no txn, even with GBRAIN_RUST_SERVED_SERIAL_TXN=1 set', () => {
    process.env[RETIRED_SWITCH] = '1';
    const options = servedServerOptionsFor({ capabilities: new Set(['served']) }, { multiuser: true });
    expect({ served: options !== undefined, transactions: options?.transactions?.() }).toEqual({ served: true, transactions: false });
  });

  test('a multi-user engine with multi_writer gets txn with the switch unset', () => {
    delete process.env[RETIRED_SWITCH];
    const options = servedServerOptionsFor({ capabilities: new Set(['multi_writer']) }, { multiuser: true });
    expect(options?.transactions?.()).toBe(true);
  });
});

describeAddon('transactions over the wire on a multi-user owner, no switch set', () => {
  let dir = '';
  let owner: RustEngine;
  let listener: ServedListener;
  const clients: RustEngine[] = [];

  async function newClient(): Promise<RustEngine> {
    const client = openRustEngine({ addon: await loadRustArmAddon(), databasePath: dir, served: { url: `gbrain+tcp://127.0.0.1:${listener.port}`, token: TOKEN } });
    await client.connect({ engine: 'rust', database_path: dir } as never);
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    delete process.env[RETIRED_SWITCH];
    dir = mkdtempSync(join(tmpdir(), 'gbrain-served-txn-no-switch-'));
    owner = openRustEngine({ addon: await loadRustArmAddon(), databasePath: dir, servedOptions: {
      verify: {
        verify: async (_engine, token) => { if (token !== TOKEN) throw new Error('Invalid token'); return { principal: { kind: 'legacy_token', id: 'owner' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null }; },
        ownerIds: async () => new Set(['owner']),
      },
    } });
    await owner.connect({ engine: 'rust', database_path: dir } as never);
    listener = await listenServed(owner.ownerServer()!, { host: '127.0.0.1', port: 0 });
  }, 120_000);

  afterAll(async () => {
    for (const client of clients.splice(0)) await client.disconnect().catch(() => undefined);
    await listener?.close().catch(() => undefined);
    await owner?.disconnect().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    restoreEnv();
  });

  test('the owner runs multi-user with multi_writer, and its client is offered txn', async () => {
    const client = await newClient();
    const caps = (servedConnectionOf(client) as { caps?: ReadonlySet<string> } | undefined)?.caps;
    expect({
      switchSet: process.env[RETIRED_SWITCH] !== undefined,
      multiuser: owner.openStore('served-txn-no-switch').multiuser,
      ownerMultiWriter: owner.capabilities.has('multi_writer'),
      served: client.capabilities.has('served'),
      clientMultiWriter: client.capabilities.has('multi_writer'),
      txn: caps?.has('txn') === true,
      servedTransaction: Object.getOwnPropertyDescriptor(client, 'transaction') !== undefined,
    }).toEqual({ switchSet: false, multiuser: true, ownerMultiWriter: true, served: true, clientMultiWriter: true, txn: true, servedTransaction: true });
  });

  test('a client transaction commits on the server', async () => {
    const client = await newClient();
    const value = await client.transaction(async tx => { await tx.putPage('notes/committed', page('Committed')); return 'done'; });
    expect({ value, onOwner: await titleOf(owner, 'notes/committed'), onClient: await titleOf(client, 'notes/committed') })
      .toEqual({ value: 'done', onOwner: 'Committed', onClient: 'Committed' });
  });

  test('a client transaction that throws rolls back: nothing of it is written', async () => {
    const client = await newClient();
    const err = await client.transaction(async tx => { await tx.putPage('notes/rolled-back', page('Rolled back')); throw new Error('callback failed'); })
      .then(() => null, (e: unknown) => e as Error);
    expect({ message: err?.message, onOwner: await titleOf(owner, 'notes/rolled-back') }).toEqual({ message: 'callback failed', onOwner: null });
  });

  test('concurrent read-modify-writes of one page from two clients all land: lost commits run again over the wire', async () => {
    const [a, b] = [await newClient(), await newClient()];
    await owner.putPage('notes/hot', page('0'));
    let runs = 0;
    const bump = (client: RustEngine, n: number) => client.transaction(async tx => {
      runs++;
      const seen = (await tx.getPage('notes/hot'))?.title ?? '';
      await tx.putPage('notes/hot', page(`${seen}+${n}`));
    });
    await Promise.all([0, 1, 2, 3].flatMap(i => [bump(a, i), bump(b, 4 + i)]));
    const parts = ((await titleOf(owner, 'notes/hot')) ?? '').split('+').slice(1).map(Number).sort((x, y) => x - y);
    expect({ parts, ranAtLeastOncePerWrite: runs >= 8 }).toEqual({ parts: [0, 1, 2, 3, 4, 5, 6, 7], ranAtLeastOncePerWrite: true });
  }, 60_000);
});
