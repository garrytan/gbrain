import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../managed-import-freshness-7323.test.ts'));
