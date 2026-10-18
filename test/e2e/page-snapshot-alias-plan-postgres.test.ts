import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../page-snapshot-alias-plan.test.ts'));
