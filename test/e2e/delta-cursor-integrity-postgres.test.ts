import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../delta-cursor-integrity.test.ts'));
