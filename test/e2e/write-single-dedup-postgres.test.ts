import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../write-single-dedup.test.ts'));
