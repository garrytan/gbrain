import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../conversation-facts-managed.test.ts'));
