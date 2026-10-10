import { test } from 'bun:test';
import { hasDatabase } from './helpers.ts';

// #5575 cross-session poisoning (spec C1) and the fail-closed write gate on
// Postgres: run direct and through transaction-mode PgBouncer
// (scripts/e2e-backend-matrix.txt). The PGLite arm runs in the unit lane.
if (hasDatabase()) {
  await import('../trust-cross-session.test.ts');
} else {
  test.skip('memory-trust cross-session parity requires DATABASE_URL', () => {});
}
