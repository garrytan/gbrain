import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../migrations-v184-v185.test.ts'));
