import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';

const OPERATIONS_AS_ANY_LIMIT = 80;

describe('operations as-any ratchet', () => {
  test('does not increase unsafe casts in operation contract files', () => {
    const operationsDir = new URL('../src/core/', import.meta.url);
    const files = readdirSync(operationsDir)
      .filter((file) => file === 'operations.ts' || /^operations-.+\.ts$/.test(file));
    const count = files.reduce((total, file) => {
      const source = readFileSync(new URL(`../src/core/${file}`, import.meta.url), 'utf8');
      return total + (source.match(/\bas any\b/g)?.length ?? 0);
    }, 0);

    expect(count).toBeLessThanOrEqual(OPERATIONS_AS_ANY_LIMIT);
  });
});
