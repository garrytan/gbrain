import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../forget-expired-live-copy-8638.test.ts'));
