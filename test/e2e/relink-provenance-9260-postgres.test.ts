import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../relink-provenance-9260.test.ts'));
