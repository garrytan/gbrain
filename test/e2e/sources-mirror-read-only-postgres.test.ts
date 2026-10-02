import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../sources-mirror-read-only.test.ts'));
