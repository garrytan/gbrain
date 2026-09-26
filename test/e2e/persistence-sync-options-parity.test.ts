import { test } from 'bun:test';
import { hasDatabase } from './helpers.ts';

if (hasDatabase()) {
  await import('../persistence-sync-options.serial.test.ts');
} else {
  test.skip('sync options parity requires PostgreSQL', () => {});
}
