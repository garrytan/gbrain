import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../migrations-v187-v188.test.ts'));
