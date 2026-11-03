import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../company-brain-private-hold-7880.test.ts'));
