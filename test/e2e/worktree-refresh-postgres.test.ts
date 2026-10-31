import { registerPostgresTests } from '../helpers/test-backends.ts';

// F0 `gbrain sources refresh` on Postgres: the same state machine, admission
// fence, claim predicates and crash recovery as the PGLite unit files.
await registerPostgresTests(
  () => import('../persistence-worktree-refresh.test.ts'),
  () => import('../persistence-worktree-refresh-restart.test.ts'),
  () => import('../worktree-refresh-orphan-7679.test.ts'),
);
