import { afterAll, beforeAll, describe, test } from 'bun:test';

// The accepted shape: save and delete in beforeAll, restore in afterAll, so
// the next file in the shard's bun process gets the snapshot fast path back.
let savedSnapshot: string | undefined;
beforeAll(() => {
  savedSnapshot = process.env.GBRAIN_PGLITE_SNAPSHOT;
  delete process.env.GBRAIN_PGLITE_SNAPSHOT;
});
afterAll(() => {
  if (savedSnapshot === undefined) delete process.env.GBRAIN_PGLITE_SNAPSHOT;
  else process.env.GBRAIN_PGLITE_SNAPSHOT = savedSnapshot;
});

describe('cold init', () => {
  test('boots', () => {});
});
