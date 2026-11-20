/**
 * BrainEngine parity: which checkouts are never written (persistence/mirror-read-only.ts readOnlyCheckout), read
 * through the typed source-state read (`readSourceState`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm, a source flagged `mirror_read_only` is `mirror_read_only`, a plain source and a
 *    missing source are null.
 *  - Regression: readOnlyCheckout read the source row through `executeRaw`, which the Rust engine refuses, so every
 *    legacy disk writer (write-through, fact fences, timeline, forget) stopped on a Rust brain.
 *  - Why existing coverage misses it: the mirror tests run on PGLite only.
 *  - Seam: none. Real engines through the parity harness.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { readOnlyCheckout } from '../../src/core/persistence/mirror-read-only.ts';

const { parityTest } = parityArms(testBackends());

describe('engine parity: read-only checkouts', () => {
  parityTest('readOnlyCheckout names a mirror source, and a plain or missing source is writable', {
    methods: ['readSourceState'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'mirror', { mirror_read_only: true }, '/var/tmp/mirror-read-only-fixture');
    await createSource(engine, backend, 'plain', {}, '/var/tmp/plain-checkout-fixture');
    const result = {
      mirror: await readOnlyCheckout(engine, 'mirror'),
      plain: await readOnlyCheckout(engine, 'plain'),
      missing: await readOnlyCheckout(engine, 'no-such-source'),
    };
    expect(result).toEqual({ mirror: 'mirror_read_only', plain: null, missing: null });
    return result;
  });
});
