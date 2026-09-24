import { test } from 'bun:test';
import { hasDatabase } from './helpers.ts';

if (hasDatabase()) {
  await import('../persistence-sync-origin-native.serial.test.ts');
} else {
  test.skip('sync origin parity requires PostgreSQL', () => {});
}
