import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../pathological/s-58-upstream-rewrite.test.ts'));
