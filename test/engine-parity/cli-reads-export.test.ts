/**
 * BrainEngine parity — the statements `gbrain export` ran through `executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member below returns the same observable result on every engine arm (PGLite always; Postgres
 *    with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1), or the Rust arm's documented answer where the store
 *    keeps nothing to read (rust/docs/store/cli-reads-export.md).
 *  - Regression: an engine that answers one of these differently writes a different export tree; the Rust engine has
 *    no SQL, so each statement has to exist as a typed member it can implement.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines.
 *  - Seam: none; every row is written through typed members on every arm. Generated values (page ids, timestamps)
 *    are compared by relation or shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

describe('engine parity: export reads', () => {
  // The export bounds its snapshot transaction to 60 s. The store has no statement timeout, so the Rust member does
  // nothing; the transaction's reads answer the same on every arm, and a bad value refuses on every arm.
  parityTest('setLocalStatementTimeout bounds the transaction and leaves its reads alone', {
    methods: ['transaction', 'setLocalStatementTimeout', 'putPage', 'getPage'],
  }, async (engine) => {
    await engine.putPage('export/one', { type: 'note', title: 'One', compiled_truth: 'body one' });
    const title = await engine.transaction(async (tx) => {
      await tx.setLocalStatementTimeout(60000);
      return (await tx.getPage('export/one'))?.title ?? null;
    });
    const refusal = await engine.transaction(tx => tx.setLocalStatementTimeout(-1)).then(() => null, (e: Error) => e.message);
    expect(refusal).toContain('non-negative integer');
    return { title, refusal };
  });
});
