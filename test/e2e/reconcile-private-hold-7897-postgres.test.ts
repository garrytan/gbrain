import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../reconcile-private-hold-7897.test.ts'));
