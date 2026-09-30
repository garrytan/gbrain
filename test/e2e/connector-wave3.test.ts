import { registerPostgresTests } from '../helpers/test-backends.ts';

// Fix wave 3 lane A (#5686, #5470, #5600): the PostgreSQL arm of the connector identity, no-op kernel and pending-batch suites.
await registerPostgresTests(
  () => import('../connector-checkpoint-identity.test.ts'),
  () => import('../connector-wave3.test.ts'),
  () => import('../noop-kernel-paths.test.ts'),
);
