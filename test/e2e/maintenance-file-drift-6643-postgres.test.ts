import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../maintenance-file-drift-6643.test.ts'));
