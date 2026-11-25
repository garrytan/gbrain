/**
 * BrainEngine parity — a loop mute (`loop_suppressions`, engine-sql/loop-mutes.ts) and a take purge tombstone
 * (`take_purges`, engine-sql/facts-purge.ts) are two tables that never see each other's rows.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: after a loop mute, every read of the take purge ledger (`readSourcePurgeFlags`, `readBeliefTombstones`,
 *    `listPurgedTakeRows`, `listRecentPurgeRequests`) answers as if the mute did not exist, also when the mute's value
 *    is a take claim's fingerprint; after a take purge, `listLoopSuppressions` lists no mute; with both kinds in one
 *    source each read lists only its own. The same observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: the Rust store kept both kinds under one key prefix (`F 0x10`), so one loop mute made the source report
 *    a take purge, matched a take claim whose fingerprint was a mute's value, and failed `listRecentPurgeRequests`
 *    with a corrupt record; PGLite and Postgres kept two tables and answered none of that.
 *  - Why existing coverage misses it: loop-mutes and take-purge-ledger each write one kind only.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const SLUG = 'people/mute-key-example';
const REQUEST = '6f9619ff-8b86-4d01-b42d-00cf4fc964aa';
const CLAIM = 'Acme will win the market';

/** The claim's fingerprint, as purge_fact reads it (loadPurgeTarget over a fact of the same text). */
async function fingerprintOf(engine: BrainEngine, rowNum: number, claim: string): Promise<string> {
  const out = await engine.insertFacts([{ fact: claim, entity_slug: SLUG, source_markdown_slug: SLUG, row_num: rowNum, kind: 'fact',
    visibility: 'world', source: 'fence' }] as never, { source_id: SRC }) as { ids: number[] };
  return (await engine.loadPurgeTarget(out.ids[0]!, SRC))!.fact_hash;
}

/** Every read of the take purge ledger on the default source. */
async function takePurgeReads(engine: BrainEngine, hash: string) {
  return {
    flags: await engine.readSourcePurgeFlags(SRC),
    tombstones: (await engine.readBeliefTombstones(SRC, [], [hash])).length,
    purgedRows: await engine.listPurgedTakeRows(SRC, [{ row_num: 1, claim: CLAIM }], null),
    recentRequests: await engine.listRecentPurgeRequests(7, 50),
  };
}

describe('engine parity: loop mutes and take purges are separate ledgers', () => {
  parityTest('a loop mute is not a take purge in any take purge read', {
    methods: ['insertFacts', 'loadPurgeTarget', 'addLoopSuppression', 'readSourcePurgeFlags', 'readBeliefTombstones',
      'listPurgedTakeRows', 'listRecentPurgeRequests'],
  }, async (engine) => {
    const hash = await fingerprintOf(engine, 1, CLAIM);
    const before = await takePurgeReads(engine, hash);
    await engine.addLoopSuppression(SRC, 'sender', 'alerts@bank-example.test');
    await engine.addLoopSuppression(SRC, 'thread', hash);
    const after = await takePurgeReads(engine, hash);
    const none = { flags: { facts: false, takes: false }, tombstones: 0, purgedRows: [], recentRequests: [] };
    expect({ before, after }).toEqual({ before: none, after: none });
    return { before, after };
  });

  parityTest('a take purge is not a loop mute, and with both kinds in a source each read lists only its own', {
    methods: ['insertFacts', 'loadPurgeTarget', 'addLoopSuppression', 'listLoopSuppressions', 'insertTakePurge',
      'readSourcePurgeFlags', 'readBeliefTombstones', 'listPurgedTakeRows', 'listRecentPurgeRequests'],
  }, async (engine) => {
    const hash = await fingerprintOf(engine, 1, CLAIM);
    await engine.insertTakePurge({ sourceId: SRC, subject: '*', claimHash: hash, requestId: REQUEST });
    await engine.insertTakePurge({ sourceId: SRC, subject: 'sender', claimHash: 'b'.repeat(64), requestId: null });
    const purgeOnly = await engine.listLoopSuppressions(SRC);
    await engine.addLoopSuppression(SRC, 'sender', 'alerts@bank-example.test');
    await engine.addLoopSuppression(SRC, 'thread', 't1');
    const both = { mutes: await engine.listLoopSuppressions(SRC), reads: await takePurgeReads(engine, hash) };
    expect(purgeOnly).toEqual([]);
    expect(both).toEqual({
      mutes: [{ kind: 'sender', value: 'alerts@bank-example.test' }, { kind: 'thread', value: 't1' }],
      reads: { flags: { facts: false, takes: true }, tombstones: 1, purgedRows: [1], recentRequests: [REQUEST] },
    });
    return { purgeOnly, both };
  });
});
