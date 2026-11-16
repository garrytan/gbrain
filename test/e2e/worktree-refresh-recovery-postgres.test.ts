import { registerPostgresTests } from '../helpers/test-backends.ts';

// F0 `gbrain sources refresh` on Postgres: crash recovery, orphaned refreshes and
// the diverged publish, split from worktree-refresh-postgres.test.ts (GST-2548).
await registerPostgresTests(
  () => import('../persistence-worktree-refresh-restart.test.ts'),
  () => import('../worktree-refresh-orphan-7679.test.ts'),
  () => import('../refresh-publish-diverged-7686.test.ts'),
  () => import('../refresh-recovery-followups-gst1465.test.ts'),
);
