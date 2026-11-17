import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../connector-cancel-finalization.test.ts'));
