import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../trust-taint-origin.test.ts'));
