import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../fence-valid-from-page-date-7247.test.ts'));
