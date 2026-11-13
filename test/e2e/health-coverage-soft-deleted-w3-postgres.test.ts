import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../health-coverage-soft-deleted-w3.test.ts'));
