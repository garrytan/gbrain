import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../fact-embedding-withdrawal-antijoin-6960.test.ts'));
