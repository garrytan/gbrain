import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../pathological/s-classic-byte-paths.test.ts'));
