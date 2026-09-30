import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../repair-command.test.ts'));
