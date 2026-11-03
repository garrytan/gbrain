import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../private-pages-grant.test.ts'));
