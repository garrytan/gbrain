import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../consolidate-ties-fenced-reimport.test.ts'));
