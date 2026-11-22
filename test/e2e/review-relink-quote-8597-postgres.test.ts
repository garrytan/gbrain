import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../review-relink-quote-8597.test.ts'));
