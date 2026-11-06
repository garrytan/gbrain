import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../google-classic-purge-8644.test.ts'));
