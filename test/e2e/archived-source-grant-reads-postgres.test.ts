import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../archived-source-grant-reads.test.ts'));
