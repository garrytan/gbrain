import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../guard-ledgers-fail-closed-7632.test.ts'));
