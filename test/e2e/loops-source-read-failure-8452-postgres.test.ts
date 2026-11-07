import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../loops-source-read-failure-8452.test.ts'));
