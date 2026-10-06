import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../truncate-cascade.test.ts'));
