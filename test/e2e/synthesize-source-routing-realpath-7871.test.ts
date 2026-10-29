import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../synthesize-source-routing-realpath-7871.test.ts'));
