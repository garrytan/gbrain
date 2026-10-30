import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../ingest-capture-private-hold-7880.test.ts'));
