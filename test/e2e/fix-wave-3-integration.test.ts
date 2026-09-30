import { registerPostgresTests } from '../helpers/test-backends.ts';

// Fix wave 3 integrated scenario gate: the PostgreSQL arm of the cross-lane checks, the chaos scenario and the timed recovery run.
await registerPostgresTests(
  () => import('../fix-wave-3-integration.test.ts'),
  () => import('../fix-wave-3-chaos.test.ts'),
  () => import('../fix-wave-3-recovery-run.test.ts'),
  () => import('../fix-wave-3-managed-embedding.serial.test.ts'),
  () => import('../fix-wave-3-connector-loops.serial.test.ts'),
);
