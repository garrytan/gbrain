import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../google-contacts-resume-8906.test.ts'));
