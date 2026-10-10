/**
 * Postgres twin of test/search/query-embed-cache-ranking.test.ts: cached and
 * fresh query embeddings rank byte-identically on PostgreSQL too.
 */
import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search/query-embed-cache-ranking.test.ts'));
