import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../write-cap-wedge-8368.test.ts'));
