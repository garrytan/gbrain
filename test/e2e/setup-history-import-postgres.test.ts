import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../setup-history-import.test.ts'));
