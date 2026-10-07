import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../repair-timeline-comments.test.ts'));
