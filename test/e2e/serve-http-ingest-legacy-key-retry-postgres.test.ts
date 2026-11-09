import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../serve-http-ingest-legacy-key-retry.test.ts'));
