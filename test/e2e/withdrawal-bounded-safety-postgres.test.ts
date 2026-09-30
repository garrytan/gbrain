import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../withdrawal-bounded-safety.test.ts'));
