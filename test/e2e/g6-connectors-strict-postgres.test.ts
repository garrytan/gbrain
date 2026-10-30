import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../g6-connectors-strict.test.ts'));
