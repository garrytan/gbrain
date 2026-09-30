import { test } from 'bun:test';
import { hasDatabase } from './helpers.ts';

if (hasDatabase()) {
  await import('../persistence-sync-company.serial.test.ts');
} else {
  test.skip('company sync parity requires PostgreSQL', () => {});
}
