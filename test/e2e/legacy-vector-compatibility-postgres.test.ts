import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../legacy-vector-compatibility.test.ts'));
