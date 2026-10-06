import { registerPostgresTests } from '../helpers/test-backends.ts';

// The PostgreSQL arm of test/query-embedding-opt-out.test.ts: no query text reaches the embedder on an opted-out brain.
await registerPostgresTests(() => import('../query-embedding-opt-out.test.ts'));
