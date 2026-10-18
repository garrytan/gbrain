import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../edge-employment-roles.test.ts'));
