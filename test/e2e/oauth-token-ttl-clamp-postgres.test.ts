import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../oauth-token-ttl-clamp.test.ts'));
