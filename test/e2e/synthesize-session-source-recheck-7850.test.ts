import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../synthesize-session-source-recheck-7850.test.ts'));
