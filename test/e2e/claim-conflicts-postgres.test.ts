import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../claim-conflicts.test.ts'));
