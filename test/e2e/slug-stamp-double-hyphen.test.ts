import { registerPostgresTests } from '../helpers/test-backends.ts';

// #5966 (W14 P1.7): the slug-stamp repair candidate on Postgres.
await registerPostgresTests(() => import('../slug-stamp-double-hyphen.test.ts'));
