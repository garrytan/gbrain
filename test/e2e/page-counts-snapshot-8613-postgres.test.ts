import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../page-counts-snapshot-8613.test.ts'));
