import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../propose-takes-rejected-7299.test.ts'));
