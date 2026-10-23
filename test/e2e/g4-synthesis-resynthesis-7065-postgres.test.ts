import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../pathological/g4-synthesis-resynthesis-7065.test.ts'));
