import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../pathological/s-managed-sync-job-pull.test.ts'));
