import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../oauth-refresh-disconnect-9364.test.ts'));
