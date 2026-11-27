/**
 * The served Rust parity arm can mint a second served client of its own brain server (multi-user lane L3, for the
 * multi-writer case C21 of lane L6): `openServedPeer(armEngine)` opens a new protocol v3 connection with its own owner
 * token, to the same server, closed with the arm.
 *
 * Mode: GBRAIN_TEST_RUST_SERVED=1 and GBRAIN_RUST_MULTIUSER=1 (which the served arm sets) are set in-run, after the
 * preload; the test asserts the owner's store reports `multiuser: true` and both clients report `served` and `multi_writer`.
 *
 * 1. Protects: the peer is a distinct served client (its own connection and principal) of the same brain; a write the
 *    arm's client made is read by the peer with the writer's read token, and the peer's write is read back by the arm;
 *    closing the arm closes the peer; any engine that is not a served arm engine gets no peer.
 * 2. Fails on: an arm whose server accepts only its own token (no second client can connect), a peer on another brain,
 *    a peer left open after the arm closed.
 * 3. Seam: none below the harness: the real served arm (owner, TLS listener, served clients).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { closeRustBrain, openRustBrain, openServedPeer, rustArmAddonPath } from './engine-parity/rust-arm.ts';
import { ownerConnectionFor } from '../src/core/rust-engine/owner-ipc/client.ts';
import { readPositionToken, withReadPosition } from '../src/core/rust-engine/served/read-position.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const saved = { served: process.env.GBRAIN_TEST_RUST_SERVED, mu: process.env.GBRAIN_RUST_MULTIUSER, log: process.env.GBRAIN_RUST_COMMIT_LOG };
const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
const NOTE = (title: string, body: string) => ({ type: 'note', title, compiled_truth: body, timeline: '' }) as never;

describeAddon('a second served client from the served parity arm', () => {
  afterAll(() => {
    restore('GBRAIN_TEST_RUST_SERVED', saved.served);
    restore('GBRAIN_RUST_MULTIUSER', saved.mu);
    restore('GBRAIN_RUST_COMMIT_LOG', saved.log);
  });

  test('the peer is its own served connection to the same brain; writes cross both ways; it closes with the arm', async () => {
    process.env.GBRAIN_TEST_RUST_SERVED = '1';
    process.env.GBRAIN_RUST_COMMIT_LOG = '1'; // read tokens on the optimistic store need the commit log
    const arm = await openRustBrain();
    let peer: Awaited<ReturnType<typeof openServedPeer>>;
    try {
      peer = await openServedPeer(arm.engine);
      expect(peer).toBeDefined();
      const store = (arm.engine as unknown as { openStore(m: string): { multiuser: boolean } }).openStore('served-peer');
      expect({ multiuser: store.multiuser, arm: arm.engine.capabilities.has('served'), peer: peer!.capabilities.has('served'),
        armMw: arm.engine.capabilities.has('multi_writer'), peerMw: peer!.capabilities.has('multi_writer') })
        .toEqual({ multiuser: true, arm: true, peer: true, armMw: true, peerMw: true });
      expect(ownerConnectionFor(peer!)).not.toBe(ownerConnectionFor(arm.engine));

      await arm.engine.putPage('notes/from-arm', NOTE('A', 'written by the arm'));
      const token = readPositionToken(arm.engine);
      expect(token).toMatch(/^cp1:/);
      expect((await withReadPosition(token!, () => peer!.getPage('notes/from-arm')))?.compiled_truth).toBe('written by the arm');
      await peer!.putPage('notes/from-peer', NOTE('P', 'written by the peer'));
      expect((await withReadPosition(readPositionToken(peer!)!, () => arm.engine.getPage('notes/from-peer')))?.compiled_truth).toBe('written by the peer');
    } finally {
      await closeRustBrain(arm.engine);
    }
    await expect(peer!.getPage('notes/from-arm')).rejects.toBeDefined();
  }, 120_000);

  test('an engine that is not a served arm engine gets no peer', async () => {
    expect(await openServedPeer({})).toBeUndefined();
  });
});
