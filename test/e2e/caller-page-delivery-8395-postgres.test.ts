import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../caller-page-delivery-8395.test.ts'));
