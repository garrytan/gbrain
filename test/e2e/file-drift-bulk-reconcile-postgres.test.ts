import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../file-drift-bulk-reconcile.test.ts'));
