import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../sync-relative-anchor-refusal-7630.test.ts'));
