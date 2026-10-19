import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../cycle-synthesize-premanaged-completion.test.ts'));
