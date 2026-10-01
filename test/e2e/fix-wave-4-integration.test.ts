import { registerPostgresTests } from '../helpers/test-backends.ts';

// Fix wave 4 integrated scenario gate: the PostgreSQL arm of the cross-lane checks and the DX-O13 recovery journeys.
await registerPostgresTests(
  () => import('../fix-wave-4-integration.test.ts'),
  () => import('../fix-wave-4-journeys.test.ts'),
);
