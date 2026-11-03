import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../restore-detach-db-only-7324.test.ts'));
