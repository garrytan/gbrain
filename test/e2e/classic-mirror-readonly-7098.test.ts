import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../classic-mirror-readonly-7098.test.ts'));
