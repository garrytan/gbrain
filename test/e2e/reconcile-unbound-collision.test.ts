import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../reconcile-unbound-collision.test.ts'));
