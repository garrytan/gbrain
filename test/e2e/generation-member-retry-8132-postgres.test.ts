import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../generation-member-retry-8132.test.ts'));
