import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../canonical-projection-history.test.ts'));
