import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../pathological/s-47-yaml-alias-bomb.test.ts'));
