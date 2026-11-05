import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../recall-confidence-grouping.test.ts'));
