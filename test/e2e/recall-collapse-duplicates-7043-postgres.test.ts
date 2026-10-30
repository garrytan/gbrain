import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../recall-collapse-duplicates-7043.test.ts'));
