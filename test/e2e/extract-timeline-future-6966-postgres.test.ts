import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../extract-timeline-future-6966.test.ts'));
