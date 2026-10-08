/**
 * Phase 4.1/4.2/4.4 and the put_page apply diet: the same page writes produce
 * the same rows, effects (the links effect included), receipts, attribution
 * and files with the single-write fast path on as with it off (publishMutation
 * and the full apply). PGLite here; Postgres in
 * test/e2e/single-write-group-parity-postgres.test.ts.
 */
import { test } from 'bun:test';
import { expectSingleWriteParity } from './helpers/single-write-parity.ts';

test('single page writes dump the same rows, effects, receipts and files with the fast path on and off (PGLite)', async () => {
  await expectSingleWriteParity();
}, 300_000);
