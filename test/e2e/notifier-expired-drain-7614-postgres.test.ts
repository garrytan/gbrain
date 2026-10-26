import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../notifier-expired-drain-7614.test.ts'));
