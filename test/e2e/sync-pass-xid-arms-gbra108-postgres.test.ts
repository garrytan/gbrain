import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../sync-pass-xid-arms-gbra108.test.ts'));
