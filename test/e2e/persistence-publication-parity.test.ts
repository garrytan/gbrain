import { test } from 'bun:test';
import { hasDatabase } from './helpers.ts';

if (hasDatabase()) {
  await import('../persistence-publication-native.serial.test.ts');
} else {
  test.skip('publication parity requires PostgreSQL', () => {});
}
