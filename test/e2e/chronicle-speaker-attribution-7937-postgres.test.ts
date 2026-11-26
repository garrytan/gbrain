import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../chronicle-speaker-attribution-7937.test.ts'));
