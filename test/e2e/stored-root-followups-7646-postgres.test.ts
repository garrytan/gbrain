import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../stored-root-followups-7646.test.ts'));
