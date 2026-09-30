import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../extract-takes-managed.test.ts'));
