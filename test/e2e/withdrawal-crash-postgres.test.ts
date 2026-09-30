import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../withdrawal-crash.slow.test.ts'));
