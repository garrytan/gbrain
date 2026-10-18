import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../persistence-git-durability-probe-6210.slow.test.ts'));
