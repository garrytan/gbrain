import { describe, test } from 'bun:test';
import { hasDatabase } from './helpers.ts';
import { expectSingleWriteParity } from '../helpers/single-write-parity.ts';

const d = hasDatabase() ? describe : describe.skip;
d('single-write fast path parity on Postgres', () => {
  test('single page writes dump the same rows, effects, receipts and files with the fast path on and off (Postgres)', async () => {
    await expectSingleWriteParity(process.env.DATABASE_URL!);
  }, 300_000);
});
