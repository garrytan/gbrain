import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../drain-lease-stamp-fence.test.ts'));
