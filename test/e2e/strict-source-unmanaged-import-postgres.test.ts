import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../strict-source-unmanaged-import.test.ts'));
