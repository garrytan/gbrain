import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../atom-retry-session-source-7869.test.ts'));
