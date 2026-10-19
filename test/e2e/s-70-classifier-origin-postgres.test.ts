import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../pathological/s-70-classifier-origin.test.ts'));
