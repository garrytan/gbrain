import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search/cosine-rescore-sql.test.ts'));
