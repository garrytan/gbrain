import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../hot-memory-invalidation.test.ts'));
