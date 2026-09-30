import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../persistence-connector-retry.test.ts'));
