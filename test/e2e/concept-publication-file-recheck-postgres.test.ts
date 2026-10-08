import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../cycle/concept-publication-file-recheck.test.ts'));
