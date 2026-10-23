import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../hot-memory-session-only-7026.test.ts'));
