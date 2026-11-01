import { registerPostgresTests } from '../helpers/test-backends.ts';

// #7827: the PostgreSQL arm of the fact subject inference test.
await registerPostgresTests(() => import('../facts-subject-infer-7827.test.ts'));
