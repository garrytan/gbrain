import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../relink-attribution-7270.test.ts'));
