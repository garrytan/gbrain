import { registerPostgresTests } from '../helpers/test-backends.ts';

// Fix wave 4 lane A (#5762, #5751): the PostgreSQL arm of the checkpoint validation and legacy working-tree file suites.
await registerPostgresTests(
  () => import('../persistence-sync-checkpoint-validation.test.ts'),
  () => import('../persistence-sync-legacy-files-5751.test.ts'),
);
