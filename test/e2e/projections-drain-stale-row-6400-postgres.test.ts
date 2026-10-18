import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../projections-drain-stale-row-6400.test.ts'));
