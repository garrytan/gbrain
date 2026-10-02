import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../projection-drain.test.ts'));
