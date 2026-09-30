import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../legacy-fact-extraction-dedup.test.ts'));
