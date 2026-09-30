import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(
  () => import('../persistence-writer-versions.test.ts'),
  () => import('../persistence-blocking-effects.test.ts'),
);
