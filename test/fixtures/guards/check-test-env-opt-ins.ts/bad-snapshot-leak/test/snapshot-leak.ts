import { describe, test } from 'bun:test';

// A module-scope delete of the snapshot path: the unit shard runs every file
// in one bun process, so every later file's PGLite cold-boots.
delete process.env.GBRAIN_PGLITE_SNAPSHOT;

describe('cold init', () => {
  test('boots', () => {});
});
