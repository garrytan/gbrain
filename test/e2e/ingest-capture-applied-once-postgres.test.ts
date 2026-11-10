import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../ingest-capture-applied-once.test.ts'));
