import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../export-snapshot.test.ts'), () => import('../export-safety.test.ts'));
