import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../managed-synthesis-postprocess.test.ts'));
