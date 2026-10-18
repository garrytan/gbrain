/** #6803 part 6 on Postgres: the PGLite suite's DB-backed asserts (shared FILTER statement, refusals, JSON split). */
import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../extraction-nudge-6803.test.ts'));
