import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../schema-client-behind-7776.test.ts'));
