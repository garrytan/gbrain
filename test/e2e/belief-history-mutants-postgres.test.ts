import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../belief-history-mutants.slow.test.ts'));
