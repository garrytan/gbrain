import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../sync-relative-anchor-guards-7630.test.ts'));
