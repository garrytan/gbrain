import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../repair-file-drift-deleted-side-d5.test.ts'));
