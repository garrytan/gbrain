import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../legacy-embedding-label-8533.test.ts'));
