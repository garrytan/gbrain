import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../extract-takes-from-pages-resolutions.test.ts'));
