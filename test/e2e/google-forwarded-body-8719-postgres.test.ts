import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../google-forwarded-body-8719.test.ts'));
