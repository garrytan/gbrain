import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../import-calls-attendees.test.ts'));
