import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../brainstorm-prefix-cache-7838.test.ts'));
