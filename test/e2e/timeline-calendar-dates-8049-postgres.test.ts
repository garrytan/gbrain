import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../timeline-calendar-dates-8049.test.ts'));
