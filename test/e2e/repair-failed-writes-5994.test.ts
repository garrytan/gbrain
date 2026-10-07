import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../repair-failed-writes-5994.test.ts'));
