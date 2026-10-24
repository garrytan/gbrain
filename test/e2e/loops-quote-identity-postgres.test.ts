import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../loops-quote-identity.serial.test.ts'));
