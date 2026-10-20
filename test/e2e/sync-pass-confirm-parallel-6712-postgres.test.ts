import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../sync-pass-confirm-parallel-6712.test.ts'));
