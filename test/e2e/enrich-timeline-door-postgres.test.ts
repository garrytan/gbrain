import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../enrich-timeline-door.test.ts'));
