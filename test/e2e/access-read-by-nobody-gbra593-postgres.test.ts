import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../access-read-by-nobody-gbra593.test.ts'));
