import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../synthesize-session-source-7805.test.ts'));
