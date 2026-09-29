import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../safe-chunk-reseal.test.ts'));
