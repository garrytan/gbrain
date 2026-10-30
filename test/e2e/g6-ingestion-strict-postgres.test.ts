import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../g6-ingestion-strict.test.ts'));
