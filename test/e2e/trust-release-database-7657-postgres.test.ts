/** PostgreSQL arm of the database-only held-write approval regressions (#7657). */
import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../trust-release-database-7657.test.ts'));
