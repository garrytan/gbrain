import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../unreadable-state-detail-7780.test.ts'));
