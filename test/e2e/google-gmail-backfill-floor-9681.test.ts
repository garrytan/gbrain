import { registerPostgresTests } from '../helpers/test-backends.ts';

// #9681: the PostgreSQL arm of the managed Gmail backfill floor suite.
await registerPostgresTests(() => import('../google-gmail-backfill-floor-9681.test.ts'));
