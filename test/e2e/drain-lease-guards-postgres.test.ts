import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../drain-lease-guards.test.ts'));
