import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../doctor-entry-deadline-6803.test.ts'));
