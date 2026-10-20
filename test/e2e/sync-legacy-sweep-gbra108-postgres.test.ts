import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../sync-legacy-sweep-gbra108.test.ts'));
