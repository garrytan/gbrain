import { registerPostgresTests } from '../helpers/test-backends.ts';

// F0 `gbrain sources refresh` on Postgres: the same state machine, admission
// fence and claim predicates as the PGLite unit files. Crash recovery, orphans
// and the diverged publish run in worktree-refresh-recovery-postgres.test.ts.
await registerPostgresTests(
  () => import('../persistence-worktree-refresh.test.ts'),
  () => import('../refresh-source-changed-retry-8617.test.ts'),
);
