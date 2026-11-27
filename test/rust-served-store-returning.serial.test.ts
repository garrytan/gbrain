/**
 * BrainEngine members that return a store object, on a protocol v3 client (served/store-returning.ts): the managed-mode
 * stores `manualLinkStore`, `topologyStore`, `gitEffectStore` and `gitDurabilityStore` (multi-user lane L3; the served
 * multi_writer run of the 211 transaction files, collate-persistence-b "a remove_link names the edges it kept").
 *
 * Mode: the owner opens with GBRAIN_RUST_MULTIUSER=1 set in-run (after the preload); the test asserts its store reports
 * `multiuser: true` and the client reports `served` and `multi_writer`.
 *
 * 1. Protects: on a served client each of these members gives a store whose method calls run on the server, outside a
 *    transaction and inside one the client opened, and answer what the owner's own store answers; every engine member
 *    whose name ends in `Store` and returns a store is served this way.
 * 2. Fails on: a member whose store object the server tries to send back (functions do not cross: OwnerIpcEncodeError).
 * 3. Existing coverage: the parity arms reach these stores only inside a server-held transaction (serial switch).
 * 4. Seam: none below the engine: a real owner, a real listener, a real served client and store.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { STORE_RETURNING_MEMBERS } from '../src/core/rust-engine/served/store-returning.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const saved = process.env.GBRAIN_RUST_MULTIUSER;
const TOKEN = 'store-returning-owner-token';
const MANAGED_STORES = ['manualLinkStore', 'topologyStore', 'gitEffectStore', 'gitDurabilityStore'] as const;
let dir = '';
let owner: RustEngine;
let listener: ServedListener;
let client: RustEngine;

/** The outcome of one store method call: its answer, or the error's class and code. */
const outcome = (p: Promise<unknown>) => p.then(value => ({ ok: true as const, value }),
  (e: unknown) => ({ ok: false as const, name: (e as Error).name, code: (e as { code?: string }).code }));

describeAddon('store-returning members on a protocol v3 client', () => {
  beforeAll(async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    dir = mkdtempSync(join(tmpdir(), 'gbrain-store-returning-'));
    owner = openRustEngine({ addon: await loadRustArmAddon(), databasePath: dir, servedOptions: {
      verify: {
        verify: async (_engine, token) => { if (token !== TOKEN) throw new Error('Invalid token'); return { principal: { kind: 'legacy_token', id: 'owner' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null }; },
        ownerIds: async () => new Set(['owner']),
      },
    } });
    await owner.connect({ engine: 'rust', database_path: dir } as never);
    await owner.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'Page A.', timeline: '' } as never);
    listener = await listenServed(owner.ownerServer()!, { host: '127.0.0.1', port: 0 });
    client = openRustEngine({ addon: await loadRustArmAddon(), databasePath: dir, served: { url: `gbrain+tcp://127.0.0.1:${listener.port}`, token: TOKEN } });
    await client.connect({ engine: 'rust', database_path: dir } as never);
  }, 120_000);

  afterAll(async () => {
    await client?.disconnect().catch(() => undefined);
    await listener?.close().catch(() => undefined);
    await owner?.disconnect().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved;
  });

  test('the owner runs multi-user and the client is a served multi-writer client', () => {
    expect({ multiuser: owner.openStore('store-returning').multiuser, served: client.capabilities.has('served'), multiWriter: client.capabilities.has('multi_writer') })
      .toEqual({ multiuser: true, served: true, multiWriter: true });
  });

  test('every managed-mode store is served as a store whose calls run on the server', () => {
    expect(MANAGED_STORES.filter(member => !STORE_RETURNING_MEMBERS.has(member))).toEqual([]);
  });

  test('manualLinkStore: a read answers on the client as on the owner, outside and inside a client transaction', async () => {
    const pageId = Number((await owner.getPage('notes/a'))?.id);
    const onOwner = await outcome((await owner.manualLinkStore()).fencedEdges(pageId, 'links'));
    const outside = await outcome((await client.manualLinkStore()).fencedEdges(pageId, 'links'));
    const inside = await outcome(client.transaction(async tx => (await tx.manualLinkStore()).fencedEdges(pageId, 'links')));
    // A typed answer either way (the managed hold refuses on a brain that is not managed): the same on all three.
    const shape = (o: Awaited<ReturnType<typeof outcome>>) => (o.ok ? o : { ok: false, code: o.code, encode: o.name === 'OwnerIpcEncodeError' });
    expect({ outside: shape(outside), inside: shape(inside) }).toEqual({ outside: shape(onOwner), inside: shape(onOwner) });
  });

  test('each managed-mode store answers on the client exactly as on the owner (a value or the same typed refusal)', async () => {
    const probe = async (engine: RustEngine, member: typeof MANAGED_STORES[number]) => {
      const store = await (engine as unknown as Record<string, () => Promise<Record<string, unknown>>>)[member]!();
      const own = await (owner as unknown as Record<string, () => Promise<Record<string, unknown>>>)[member]!();
      const method = Object.keys(own).sort()[0]!;
      return { member, method, out: await outcome(Promise.resolve().then(() => (store[method] as (...a: unknown[]) => Promise<unknown>)())) };
    };
    for (const member of MANAGED_STORES) {
      const viaOwner = await probe(owner, member);
      const viaClient = await probe(client, member);
      expect(viaClient.out.ok ? viaClient.out : { ok: false, code: viaClient.out.code, name: viaClient.out.name === 'OwnerIpcEncodeError' ? 'OwnerIpcEncodeError' : 'typed' })
        .toEqual(viaOwner.out.ok ? viaOwner.out : { ok: false, code: viaOwner.out.code, name: 'typed' });
    }
  });
});
