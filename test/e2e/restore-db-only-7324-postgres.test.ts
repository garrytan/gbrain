import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../restore-db-only-7324.test.ts'));
