/** Execute the shared handle-identity keyword paging regressions on real PostgreSQL. */
import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../keyword-handle-7972.test.ts'));
