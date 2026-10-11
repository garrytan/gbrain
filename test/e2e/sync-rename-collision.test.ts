import { registerPostgresTests } from '../helpers/test-backends.ts';

// #5431 (W14 P1.8): the rename-collision classifier and the page-id reference mover on Postgres.
await registerPostgresTests(() => import('../sync-rename-collision.test.ts'));
