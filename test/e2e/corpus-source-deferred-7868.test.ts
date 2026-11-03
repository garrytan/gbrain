import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../corpus-source-deferred-7868.test.ts'));
