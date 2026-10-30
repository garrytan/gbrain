import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../managed-links-fence.test.ts'));
