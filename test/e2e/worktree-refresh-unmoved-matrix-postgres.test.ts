import { registerPostgresTests } from '../helpers/test-backends.ts';

// #7679 state matrix 7d of `gbrain sources refresh` on Postgres, split from worktree-refresh-postgres.test.ts (#8025).
await registerPostgresTests(() => import('../worktree-refresh-unmoved-matrix-7679.test.ts'));
