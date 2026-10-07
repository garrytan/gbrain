import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../fence-census.test.ts'));
