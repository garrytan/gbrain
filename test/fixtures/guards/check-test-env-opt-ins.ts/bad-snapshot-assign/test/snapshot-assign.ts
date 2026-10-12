import { describe, test } from 'bun:test';

// The same leak through an assignment inside a module-scope block (no
// function boundary): every later file in the shard sees the new path.
if (process.env.GBRAIN_TEST_FIXTURE_COLD === '1') {
  process.env['GBRAIN_PGLITE_SNAPSHOT'] = '/nonexistent/snapshot.tar';
}

describe('cold init', () => {
  test('boots', () => {});
});
