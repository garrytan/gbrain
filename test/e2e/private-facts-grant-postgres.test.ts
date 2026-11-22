import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../private-facts-grant-8194.test.ts'));
