import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../fact-embedding-truncation-6975.test.ts'));
