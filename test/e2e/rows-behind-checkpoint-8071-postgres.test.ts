import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../rows-behind-checkpoint-8071.test.ts'));
