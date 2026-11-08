import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../refresh-drained-commits-8828.test.ts'));
