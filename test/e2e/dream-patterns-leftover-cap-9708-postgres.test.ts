import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../dream-patterns-leftover-cap-9708.test.ts'));
