import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../daily-ledger.test.ts'));
