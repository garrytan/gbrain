import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(
  () => import('../persistence-admin-recovery.test.ts'),
  () => import('../persistence-onboarding.test.ts'),
);
