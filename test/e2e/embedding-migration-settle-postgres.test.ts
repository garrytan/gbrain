import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../embedding-migration-settle.serial.test.ts'));
