import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../embedding-zero-norm-4616.serial.test.ts'));
