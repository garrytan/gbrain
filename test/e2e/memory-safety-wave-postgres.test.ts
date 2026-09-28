import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../memory-safety-wave.serial.test.ts'));
