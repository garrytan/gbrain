import { registerPostgresTests } from '../helpers/test-backends.ts';

// Guest notes, slice 1 (GBRA-504) on Postgres: the guest record tables, the
// trust trigger's guest ceiling and writer backstop, direct and through
// transaction-mode PgBouncer (scripts/e2e-backend-matrix.txt).
await registerPostgresTests(() => import('../guest-notes-schema.test.ts'));
