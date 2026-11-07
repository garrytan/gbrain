import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(
  () => import('../protocol-publication-refusal-7777.test.ts'),
  () => import('../persistence-publication-refusal-5974.test.ts'),
);
