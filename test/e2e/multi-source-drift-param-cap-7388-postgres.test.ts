import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../multi-source-drift-param-cap-7388.test.ts'));
