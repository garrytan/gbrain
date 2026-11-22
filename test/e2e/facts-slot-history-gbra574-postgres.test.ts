import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../facts-slot-history-gbra574.test.ts'));
