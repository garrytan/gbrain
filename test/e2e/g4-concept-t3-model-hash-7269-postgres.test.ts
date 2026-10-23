import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../pathological/g4-concept-t3-model-hash-7269.test.ts'));
