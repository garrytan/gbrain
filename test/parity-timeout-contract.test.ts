import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

describe('SQLite/PGLite parity timeout contract', () => {
  test('PGLite parity seeds carry an explicit timeout budget', () => {
    const source = readFileSync(new URL('./parity.test.ts', import.meta.url), 'utf-8');
    const explicitTimeoutUses = source.match(/SQLITE_PGLITE_PARITY_TIMEOUT_MS/g) ?? [];

    expect(source).toContain('const SQLITE_PGLITE_PARITY_TIMEOUT_MS');
    expect(source).toContain('TEST_TIMEOUT_MS');
    expect(explicitTimeoutUses.length).toBeGreaterThanOrEqual(8);
  });
});
