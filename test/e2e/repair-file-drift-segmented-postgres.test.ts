import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../large-pages/repair-file-drift-segmented.test.ts'));
