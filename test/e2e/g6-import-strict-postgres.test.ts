import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../g6-import-strict.test.ts'));
