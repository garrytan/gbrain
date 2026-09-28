import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../embedding-recovery.serial.test.ts'));
