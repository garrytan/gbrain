import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(
  () => import('../page-projection-origin.test.ts'),
  () => import('../page-projection-vector-preservation.test.ts'),
  () => import('../page-projection-code-recovery.test.ts'),
  () => import('../code-projection-edge-recovery.test.ts'),
  () => import('../symbol-resolver-projection-race.test.ts'),
);
