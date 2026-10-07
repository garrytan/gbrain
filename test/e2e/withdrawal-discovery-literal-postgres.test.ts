import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../withdrawal-discovery-literal.test.ts'));
