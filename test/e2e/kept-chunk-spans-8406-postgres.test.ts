import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../kept-chunk-spans-8406.test.ts'));
