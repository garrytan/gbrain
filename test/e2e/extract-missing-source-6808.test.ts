/** Real PostgreSQL execution of the shared missing-source drain contracts. */
import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../extract-missing-source-6808.test.ts'));
