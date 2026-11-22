import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../archive-rescope-on-shared.test.ts'));
