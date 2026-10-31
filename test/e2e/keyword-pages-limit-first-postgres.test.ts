import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search/keyword-pages-limit-first.test.ts'));
