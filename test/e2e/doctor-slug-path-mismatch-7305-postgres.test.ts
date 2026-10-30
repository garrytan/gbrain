import { registerPostgresTests } from '../helpers/test-backends.ts';

// #7305: the slug_path_mismatch doctor check on Postgres.
await registerPostgresTests(() => import('../doctor-slug-path-mismatch-7305.test.ts'));
