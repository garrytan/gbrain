import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../patterns-staged-writes.test.ts'));
