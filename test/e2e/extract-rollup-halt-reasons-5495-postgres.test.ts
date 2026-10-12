import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../extract-rollup-halt-reasons-5495.test.ts'));
