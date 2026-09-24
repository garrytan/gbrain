import { test } from 'bun:test';
import { hasDatabase } from './helpers.ts';

if (hasDatabase()) {
  await import('../unsupported-embedding-identity.serial.test.ts');
  await import('../embedding-identity-companions.serial.test.ts');
} else {
  test.skip('stored embedding identity parity requires PostgreSQL', () => {});
}
