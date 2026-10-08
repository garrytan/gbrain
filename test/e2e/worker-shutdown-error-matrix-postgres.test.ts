import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../worker-shutdown-error-matrix.test.ts'));
