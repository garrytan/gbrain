import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../image-distrusted-reimport.test.ts'));
