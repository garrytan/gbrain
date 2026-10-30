import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../timeline-entry-autolinks.test.ts'));
