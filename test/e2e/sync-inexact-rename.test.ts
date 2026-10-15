import { registerPostgresTests } from '../helpers/test-backends.ts';

// #6729: inexact Git pairs must not transfer another person's retained identity.
await registerPostgresTests(() => import('../sync-inexact-rename.test.ts'));
