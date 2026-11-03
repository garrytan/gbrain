import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../url-clone-fences-private-hold-7897.test.ts'));
