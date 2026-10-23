import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../session-start-hook-dedupe-7026.test.ts'));
