/**
 * A transaction over the wire that loses its commit keeps its place in line when the client runs it again (multi-user
 * Rust, interface I-1; known red 6: C11 on the served env route ended `transaction_contention` after 9 lost runs).
 *
 * In process, a rerun of an optimistic transaction keeps the first run's single-flight age and first queues for the
 * keys the earlier runs lost on (optimistic-transaction.ts), so it gets through once it is the oldest. Over the wire the
 * server ends a transaction whose commit lost and the client runs its callback again from a fresh transaction
 * (served/engine.ts). That fresh transaction must keep the same age and lost keys, or each rerun is again the youngest
 * writer of a hot key and can lose every time while writers that started later commit.
 *
 * 1. Protects: under forced contention on one hot key (every callback holds its snapshot across round trips), every
 *    transaction over the wire commits; one slow transaction gets through while fast writers on other connections keep
 *    committing; a transaction that ends without committing leaves nothing behind (no lost, partial or repeated write).
 * 2. Fails on: a client rerun that starts from a fresh age and no lost keys (the starvation), a rerun state that
 *    reaches a different connection, a give-up that kept any of its writes.
 * 3. Existing coverage: rust-served-txn-retry.test.ts covers rerun and give-up against a fake engine that never queues;
 *    rust-engine-multiuser-transactions.serial.test.ts covers the in-process rerun.
 * 4. Seam: a real multi-user Rust brain with the commit log on, served over loopback TLS (the served arm's helpers).
 *    The contention comes from the callbacks themselves (each sleeps while it holds its snapshot), not from machine load.
 *
 * Needs the Rust addon: runs whenever it is built (or GBRAIN_TEST_RUST_ARM=1 asks for it), skips without it, and fails
 * without it under GBRAIN_TEST_RUST_ADDON_REQUIRED=1, as rust-engine-multiuser-transactions.serial.test.ts does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { existsSync } from 'node:fs';
import { closeRustBrain, openRustBrain, openServedPeer, rustArmAddonPath, rustArmRequested, type RustBrainDir } from './engine-parity/rust-arm.ts';

const SRC = 'default';
const HOT = 'people/charlie-example';
const SWITCHES = ['GBRAIN_TEST_RUST_SERVED', 'GBRAIN_RUST_MULTIUSER', 'GBRAIN_RUST_COMMIT_LOG', 'GBRAIN_RUST_SERVED_SERIAL_TXN'] as const;

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist; run bun run rust:build`);
}

type Outcome = { committed: true } | { committed: false; code?: string; reason?: string };

describe.skipIf(!HAVE_ADDON && !rustArmRequested())('a transaction over the wire keeps its place in line when it runs again', () => {
  const saved = new Map<string, string | undefined>();
  let brain: RustBrainDir;
  beforeAll(async () => {
    for (const name of SWITCHES) saved.set(name, process.env[name]);
    process.env.GBRAIN_TEST_RUST_SERVED = '1';
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    process.env.GBRAIN_RUST_COMMIT_LOG = '1';
    brain = await openRustBrain();
  }, 120_000);
  afterAll(async () => {
    if (brain) await closeRustBrain(brain.engine);
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }, 60_000);

  /** One transaction that appends `text` to the hot entity and holds its snapshot for `holdMs`; never throws. */
  async function append(engine: BrainEngine, text: string, holdMs: number, runs?: { n: number }): Promise<Outcome> {
    try {
      await engine.transaction(async (tx) => {
        if (runs) runs.n++;
        const out = await tx.insertFact({ fact: text, entity_slug: HOT, source: 'mcp:remember' }, { source_id: SRC });
        expect(out.status).toBe('inserted');
        await Bun.sleep(holdMs);
      });
      return { committed: true };
    } catch (error) {
      const e = error as { code?: string; reason?: string };
      return { committed: false, code: e.code, reason: e.reason };
    }
  }

  /** Every fact text on the hot entity, in commit order. */
  async function hotFacts(engine: BrainEngine): Promise<string[]> {
    const rows = await engine.listFactsByEntity(SRC, HOT, { limit: 1000 });
    return rows.map(r => String((r as { fact: string }).fact));
  }

  test('eight writers on one connection, four transactions each, all on one hot key: every one commits, nothing lost or repeated', async () => {
    const engine = brain.engine as unknown as BrainEngine;
    const before = await hotFacts(engine);
    const outcomes = await Promise.all(Array.from({ length: 8 }, async (_, w) => {
      const mine: Array<{ text: string; outcome: Outcome }> = [];
      for (let n = 0; n < 4; n++) {
        const text = `crowd ${w} ${n}`;
        mine.push({ text, outcome: await append(engine, text, 15) });
      }
      return mine;
    }));
    const all = outcomes.flat();
    const kept = (await hotFacts(engine)).filter(f => !before.includes(f));
    // Integrity first: a transaction that gave up kept nothing, and no write is lost or kept twice.
    expect([...kept].sort(), 'a write was lost, kept twice, or kept from a transaction that gave up')
      .toEqual(all.filter(a => a.outcome.committed).map(a => a.text).sort());
    // Then fairness: under this contention every transaction gets through.
    expect(all.filter(a => !a.outcome.committed).map(a => `${a.text}: ${JSON.stringify(a.outcome)}`), 'a writer lost to concurrent writers until it gave up').toEqual([]);
  }, 120_000);

  test('one slow transaction gets through while fast writers on three other connections keep committing', async () => {
    const engine = brain.engine as unknown as BrainEngine;
    const peers = await Promise.all([0, 1, 2].map(async () => (await openServedPeer(brain.engine)) as unknown as BrainEngine));
    let done = false;
    let fastCommits = 0;
    const fast = async (peer: BrainEngine, p: number) => {
      for (let n = 0; !done && n < 300; n++) {
        const outcome = await append(peer, `fast ${p} ${n}`, 0);
        expect(outcome, `fast writer ${p} gave up`).toEqual({ committed: true });
        fastCommits++;
      }
    };
    const runs = { n: 0 };
    const slow = append(engine, 'slow 0', 60, runs).finally(() => { done = true; });
    const [outcome] = await Promise.all([slow, ...peers.map((peer, p) => fast(peer, p))]);
    expect({ outcome, fastStillCommitted: fastCommits > 0 }, `the slow transaction ran ${runs.n} times`).toEqual({ outcome: { committed: true }, fastStillCommitted: true });
    expect((await hotFacts(engine)).filter(f => f === 'slow 0')).toHaveLength(1);
  }, 120_000);
});
