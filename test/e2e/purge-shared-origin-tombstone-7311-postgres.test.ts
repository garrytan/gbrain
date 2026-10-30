import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../purge-shared-origin-tombstone-7311.test.ts'));
