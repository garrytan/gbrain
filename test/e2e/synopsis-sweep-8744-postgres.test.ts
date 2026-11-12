import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../synopsis-sweep-8744.serial.test.ts'));
