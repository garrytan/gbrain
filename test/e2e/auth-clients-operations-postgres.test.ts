import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../auth-clients-operations.test.ts'));
