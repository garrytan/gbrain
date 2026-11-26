import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../schema-pack/suggest-known-10433.test.ts'));
