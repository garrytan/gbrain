import { registerPostgresTests } from '../helpers/test-backends.ts';

// #5914 (W14 P1.3 / P1.3c): the recreated-root waiver and the symlink rebind on Postgres.
await registerPostgresTests(
  () => import('../physical-root-relocated.test.ts'),
  () => import('../physical-root-symlink.test.ts'),
);
