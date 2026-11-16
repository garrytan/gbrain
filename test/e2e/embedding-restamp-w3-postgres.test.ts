import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../embedding-restamp-w3.test.ts'));
