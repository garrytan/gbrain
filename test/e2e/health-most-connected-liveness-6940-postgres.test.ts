import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../health-most-connected-liveness-6940.test.ts'));
