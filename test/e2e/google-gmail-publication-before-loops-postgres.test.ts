import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../google-gmail-publication-before-loops-9011.test.ts'));
