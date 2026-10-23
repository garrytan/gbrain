import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../chronicle-malformed-diagnostics-7234.test.ts'));
