import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(
  () => import('../import-inline-chunk-keep.test.ts'),
  () => import('../persistence-edit-embedding-reuse.test.ts'),
);
