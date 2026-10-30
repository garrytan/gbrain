import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../conversation-facts-source-dedup-7043.test.ts'));
