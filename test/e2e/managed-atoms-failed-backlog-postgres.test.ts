import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../managed-atoms-failed-backlog.test.ts'));
