import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../chronicle-max-events-5329.test.ts'));
