/** #7492 coverage by token and class on PostgreSQL: the dual-backend cases in test/search/coverage-token-class-7492.test.ts. */
import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search/coverage-token-class-7492.test.ts'));
