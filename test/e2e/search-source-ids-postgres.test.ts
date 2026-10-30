import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search/search-source-ids.test.ts'));
