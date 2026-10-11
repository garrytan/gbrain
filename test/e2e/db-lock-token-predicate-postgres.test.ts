import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../db-lock-token-predicate.test.ts'));
