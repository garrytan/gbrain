import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../ghost-pages-6696.test.ts'));
