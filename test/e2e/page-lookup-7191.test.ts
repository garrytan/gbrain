import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../page-lookup-7191.test.ts'));
