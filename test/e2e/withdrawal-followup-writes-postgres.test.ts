import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../withdrawal-followup-writes.test.ts'));
