import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../reindex-page-projection.test.ts'));
