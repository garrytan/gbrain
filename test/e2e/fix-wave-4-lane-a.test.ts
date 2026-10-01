import { registerPostgresTests } from '../helpers/test-backends.ts';

// Fix wave 4 lane A (#5762, #5751, #5522): the PostgreSQL arm of the checkpoint validation, legacy working-tree file and overtaken cursor suites.
await registerPostgresTests(
  () => import('../persistence-sync-checkpoint-validation.test.ts'),
  () => import('../persistence-sync-legacy-files-5751.test.ts'),
  () => import('../persistence-sync-overtaken-cursor-5522.test.ts'),
);
