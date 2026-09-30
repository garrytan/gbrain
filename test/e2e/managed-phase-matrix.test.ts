import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../managed-phase-matrix.test.ts'));
