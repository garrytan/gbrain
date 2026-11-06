import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../sync-relative-anchor-sources-doctor-7630.test.ts'));
