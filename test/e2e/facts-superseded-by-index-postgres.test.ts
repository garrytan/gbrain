import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../facts-superseded-by-index.test.ts'));
