import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../persistence-sync-failures.serial.test.ts'));
