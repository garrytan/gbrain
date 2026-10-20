import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../fold-hook-noop-6712.test.ts'));
