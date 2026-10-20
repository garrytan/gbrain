import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../keep-db-pass-admission.test.ts'));
