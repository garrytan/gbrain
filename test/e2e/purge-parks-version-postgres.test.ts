import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../purge-parks-version.test.ts'));
