import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../sync-code-history-9771.test.ts'));
