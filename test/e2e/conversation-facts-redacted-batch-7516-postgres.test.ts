import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../conversation-facts-redacted-batch-7516.test.ts'));
