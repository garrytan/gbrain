import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../facts-fts-index.test.ts'));
