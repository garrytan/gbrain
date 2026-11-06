import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../repair-failed-writes-bounded-8707.test.ts'));
