import { registerPostgresTests } from '../helpers/test-backends.ts';

// #7305: hyphen-run slugs at write time on Postgres.
await registerPostgresTests(() => import('../hyphen-run-slugs-7305.test.ts'));
