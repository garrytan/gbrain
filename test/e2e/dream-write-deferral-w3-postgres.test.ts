import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../dream-write-deferral-w3.test.ts'));
