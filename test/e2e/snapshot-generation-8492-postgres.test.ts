import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../large-pages/snapshot-generation-8492.test.ts'));
