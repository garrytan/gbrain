import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../cycle-patterns-segmented.test.ts'));
