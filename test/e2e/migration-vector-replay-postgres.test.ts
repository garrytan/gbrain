import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../migration-vector-replay.test.ts'));
