import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../doctor-index-audit-constraints-9966.test.ts'));
