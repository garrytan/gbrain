import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../writer-fence-fail-closed-7636.test.ts'));
