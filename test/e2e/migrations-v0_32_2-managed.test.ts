import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../migrations-v0_32_2-managed.test.ts'));
