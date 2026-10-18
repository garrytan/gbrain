import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../engine-sql-links-code-references.test.ts'));
