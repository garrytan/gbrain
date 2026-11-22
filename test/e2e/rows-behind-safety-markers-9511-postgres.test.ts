import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../rows-behind-safety-markers-9511.test.ts'));
