import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(
  () => import('../persistence-effect-retry.test.ts'),
  () => import('../persistence-embedding-effects.test.ts'),
);
