import { test } from 'bun:test';
import { hasDatabase } from './helpers.ts';

if (hasDatabase()) {
  await import('../page-projection-origin.test.ts');
  await import('../page-projection-code-recovery.test.ts');
  await import('../code-projection-edge-recovery.test.ts');
  await import('../symbol-resolver-projection-race.test.ts');
} else {
  test.skip('projection recovery parity requires PostgreSQL', () => {});
}
