import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../loops-noise-5012-store.test.ts'));
