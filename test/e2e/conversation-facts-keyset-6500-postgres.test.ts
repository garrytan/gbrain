import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../conversation-facts-keyset-6500.test.ts'));
