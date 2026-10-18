/**
 * Postgres arm of the #5575 write gate storage scenarios
 * (test/write-gate-store.test.ts runs the same bodies on PGLite): receipts
 * and holds, including the JSONB payload binding PGLite cannot check.
 */
import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../write-gate-store.test.ts'));
