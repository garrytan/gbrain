import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../sum-stale-chunk-chars-8811.test.ts'));
