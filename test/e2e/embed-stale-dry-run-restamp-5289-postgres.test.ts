import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../embed-stale-dry-run-restamp-5289.serial.test.ts'));
