import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../attendance-repair.test.ts'));
