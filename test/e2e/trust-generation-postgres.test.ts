import { registerPostgresTests } from '../helpers/test-backends.ts';

// Trust policy generation (#5575 ENG-11) on Postgres: the deferred generation
// triggers, and hot memory plus the OpenClaw core lane revalidating warmed
// caches after each trust transition, direct and through transaction-mode
// PgBouncer (scripts/e2e-backend-matrix.txt).
await registerPostgresTests(() => import('../trust-generation.test.ts'));
await registerPostgresTests(() => import('../trust-cache-invalidation.test.ts'));
