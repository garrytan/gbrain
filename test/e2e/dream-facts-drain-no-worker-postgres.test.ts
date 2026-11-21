import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../dream-facts-drain-no-worker.test.ts'));
