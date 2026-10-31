import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../brainstorm-private-hold-7897.test.ts'));
