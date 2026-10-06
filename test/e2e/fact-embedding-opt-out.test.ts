import { registerPostgresTests } from '../helpers/test-backends.ts';

// The PostgreSQL arm of test/fact-embedding-opt-out.test.ts: no fact text reaches the embedder on an opted-out brain.
await registerPostgresTests(() => import('../fact-embedding-opt-out.test.ts'));
