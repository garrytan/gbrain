import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../recall-question.test.ts'));
