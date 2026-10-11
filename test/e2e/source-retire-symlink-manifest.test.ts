import { registerPostgresTests } from '../helpers/test-backends.ts';

// #5200 (W14 P1.4): retire skips the manifest walk and refreshes canonical_stamp in place on Postgres.
await registerPostgresTests(() => import('../source-retire-symlink-manifest.test.ts'));
