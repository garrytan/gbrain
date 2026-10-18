import { describe, test } from 'bun:test';

// An E2E file runs in its own bun process (scripts/run-e2e.sh); exempt.
delete process.env.GBRAIN_PGLITE_SNAPSHOT;

describe('cold init', () => {
  test('boots', () => {});
});
