import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../connector-private-transition-7971.test.ts'));
