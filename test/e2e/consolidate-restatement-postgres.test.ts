import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../consolidate-restatement.test.ts'));
