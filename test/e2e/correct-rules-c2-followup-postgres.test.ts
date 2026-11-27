import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../correct-rules-c2-followup.test.ts'));
