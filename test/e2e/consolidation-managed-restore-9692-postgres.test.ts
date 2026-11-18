import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../consolidation-managed-restore-9692.test.ts'));
