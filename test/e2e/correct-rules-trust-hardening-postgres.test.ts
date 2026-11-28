import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../correct-rules-trust-hardening.test.ts'));
