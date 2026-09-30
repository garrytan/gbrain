import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../managed-facts-writers.test.ts'));
