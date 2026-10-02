import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../projection-embedding-input-hash.test.ts'));
