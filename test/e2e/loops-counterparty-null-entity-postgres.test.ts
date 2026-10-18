import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../loops-counterparty-null-entity.test.ts'));
