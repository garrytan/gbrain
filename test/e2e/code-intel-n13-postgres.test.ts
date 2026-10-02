import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../code-intel/n13-edge-resolution.test.ts'));
